//! The bounded event queue.
//!
//! Every counter that participates in the documented statistics invariant lives inside the same
//! mutex as the ring buffer, so [`EventQueue::snapshot`] is a genuine point-in-time snapshot
//! rather than a set of independently-read atomics that can disagree.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};

use crate::event::FileEvent;

/// Ring slots kept allocated between bursts.
///
/// A burst is absorbed by growing the ring, and a `VecDeque` never returns capacity on its own — so
/// without a floor to fall back to, a process holds the largest burst it ever saw for the rest of its
/// life. One `git checkout` of a large tree would permanently cost a full queue's worth of slots.
const RING_BASELINE: usize = 1024;

/// How far past the baseline an idle ring must have grown before its buffer is returned.
///
/// Hysteresis, so that a queue oscillating around its working set never reallocates: only a *drained*
/// ring holding at least this multiple of the baseline is shrunk. The cost when it does apply is one
/// allocation, set against the thousands of pushes that grew the ring in the first place.
const RING_SHRINK_FACTOR: usize = 4;

/// What happened to an event offered to the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Push {
    /// The event was queued.
    Accepted,
    /// The queue was full: the event was dropped. `rescan_raised` is `true` if this drop is the
    /// one that raised the rescan signal (so the caller broadcasts it exactly once per episode).
    Overflow { rescan_raised: bool },
}

struct State {
    ring: VecDeque<FileEvent>,
    queued: u64,
    delivered: u64,
    dropped: u64,
    /// A rescan signal that has been raised but not yet delivered. Held outside the ring so it
    /// can always be signalled, including when the ring is full — the whole point of the signal
    /// is that it survives overflow.
    rescan_pending: bool,
    /// Whether producers are attached. When `false`, waiters do not block on an empty queue.
    active: bool,
}

pub(crate) struct EventQueue {
    state: Mutex<State>,
    ready: Condvar,
    capacity: usize,
    /// Ring slots the queue is willing to hold while idle. See [`RING_BASELINE`].
    baseline: usize,
}

impl EventQueue {
    pub(crate) fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        let baseline = capacity.min(RING_BASELINE);
        Self {
            state: Mutex::new(State {
                ring: VecDeque::with_capacity(baseline),
                queued: 0,
                delivered: 0,
                dropped: 0,
                rescan_pending: false,
                active: false,
            }),
            ready: Condvar::new(),
            capacity,
            baseline,
        }
    }

    pub(crate) fn capacity(&self) -> usize {
        self.capacity
    }

    /// Offer an event to the queue.
    pub(crate) fn push(&self, event: FileEvent) -> Push {
        let mut state = self.state.lock();
        if state.ring.len() >= self.capacity {
            state.dropped += 1;
            let rescan_raised = !state.rescan_pending;
            if rescan_raised {
                state.rescan_pending = true;
                state.queued += 1;
            }
            drop(state);
            // A waiter blocked on an empty-but-overflowing queue is impossible, but the rescan
            // signal is newly readable, so wake anyway.
            self.ready.notify_all();
            return Push::Overflow { rescan_raised };
        }
        state.ring.push_back(event);
        state.queued += 1;
        drop(state);
        self.ready.notify_one();
        Push::Accepted
    }

    /// Raise the rescan signal without dropping anything (kernel-reported overflow).
    ///
    /// Returns `true` if this call raised it, `false` if one was already pending.
    pub(crate) fn raise_rescan(&self) -> bool {
        let mut state = self.state.lock();
        if state.rescan_pending {
            return false;
        }
        state.rescan_pending = true;
        state.queued += 1;
        drop(state);
        self.ready.notify_all();
        true
    }

    /// Remove the next event, if any.
    ///
    /// A pending rescan signal jumps the queue: it tells the consumer that the stream is no
    /// longer authoritative, which is information it needs *before* it acts on stale events.
    pub(crate) fn pop(&self) -> Option<FileEvent> {
        let mut state = self.state.lock();
        self.take(&mut state)
    }

    /// Remove the next event, blocking until one arrives or `timeout` elapses.
    ///
    /// Returns immediately when the queue is empty and no producer is attached, so a stopped
    /// watcher does not make callers pay the whole timeout.
    pub(crate) fn pop_wait(&self, timeout: Duration) -> Option<FileEvent> {
        let deadline = Instant::now().checked_add(timeout);
        let mut state = self.state.lock();
        loop {
            if let Some(event) = self.take(&mut state) {
                return Some(event);
            }
            if !state.active {
                return None;
            }
            let remaining = match deadline {
                Some(deadline) => deadline.checked_duration_since(Instant::now())?,
                // `timeout` overflowed the clock: treat it as "wait a long time" rather than
                // spinning or panicking.
                None => Duration::from_secs(3600),
            };
            if self.ready.wait_for(&mut state, remaining).timed_out() {
                return self.take(&mut state);
            }
        }
    }

    fn take(&self, state: &mut State) -> Option<FileEvent> {
        if state.rescan_pending {
            state.rescan_pending = false;
            state.delivered += 1;
            return Some(FileEvent::rescan());
        }
        let event = state.ring.pop_front()?;
        state.delivered += 1;
        // The drain that emptied a burst-sized ring is the moment to hand its buffer back; see
        // `RING_SHRINK_FACTOR` for why this is conditional rather than unconditional.
        if state.ring.is_empty() && state.ring.capacity() >= self.baseline * RING_SHRINK_FACTOR {
            state.ring.shrink_to(self.baseline);
        }
        Some(event)
    }

    /// `(queued, dropped, delivered, pending)` read under one lock.
    pub(crate) fn snapshot(&self) -> (u64, u64, u64, usize) {
        let state = self.state.lock();
        (
            state.queued,
            state.dropped,
            state.delivered,
            state.ring.len() + usize::from(state.rescan_pending),
        )
    }

    /// Approximate heap bytes held by the ring: its allocated slots plus the paths still queued.
    ///
    /// Counts allocated slots rather than occupied ones deliberately — an empty ring that kept a
    /// burst's buffer is exactly the leak this is here to make visible.
    pub(crate) fn retained_bytes(&self) -> usize {
        let state = self.state.lock();
        state.ring.capacity() * std::mem::size_of::<FileEvent>()
            + state
                .ring
                .iter()
                .map(|event| event.path.as_os_str().len())
                .sum::<usize>()
    }

    /// Mark producers as attached or detached, waking any waiters.
    pub(crate) fn set_active(&self, active: bool) {
        self.state.lock().active = active;
        self.ready.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::EventKind;
    use std::path::Path;
    use std::sync::Arc;
    use std::thread;

    fn event(name: &str) -> FileEvent {
        FileEvent::new(name.into(), EventKind::Modified, 0, false)
    }

    #[test]
    fn fifo_order_is_preserved() {
        let queue = EventQueue::new(8);
        for name in ["a", "b", "c"] {
            assert_eq!(queue.push(event(name)), Push::Accepted);
        }
        let popped: Vec<_> = std::iter::from_fn(|| queue.pop())
            .map(|e| e.path.to_string_lossy().into_owned())
            .collect();
        assert_eq!(popped, ["a", "b", "c"]);
    }

    #[test]
    fn capacity_is_clamped_to_at_least_one() {
        let queue = EventQueue::new(0);
        assert_eq!(queue.capacity(), 1);
        assert_eq!(queue.push(event("a")), Push::Accepted);
        assert!(matches!(queue.push(event("b")), Push::Overflow { .. }));
    }

    #[test]
    fn overflow_drops_and_raises_rescan_once() {
        let queue = EventQueue::new(2);
        assert_eq!(queue.push(event("a")), Push::Accepted);
        assert_eq!(queue.push(event("b")), Push::Accepted);
        assert_eq!(
            queue.push(event("c")),
            Push::Overflow {
                rescan_raised: true
            }
        );
        assert_eq!(
            queue.push(event("d")),
            Push::Overflow {
                rescan_raised: false
            }
        );

        let (queued, dropped, delivered, pending) = queue.snapshot();
        assert_eq!(dropped, 2, "both overflowing events are dropped");
        assert_eq!(queued, 3, "two accepted plus one rescan signal");
        assert_eq!(delivered, 0);
        assert_eq!(pending, 3, "two queued events plus the rescan signal");
    }

    #[test]
    fn rescan_is_delivered_before_queued_events() {
        let queue = EventQueue::new(1);
        assert_eq!(queue.push(event("a")), Push::Accepted);
        assert!(matches!(queue.push(event("b")), Push::Overflow { .. }));

        let first = queue.pop().expect("rescan");
        assert_eq!(first.kind, EventKind::RescanRequired);
        let second = queue.pop().expect("queued event");
        assert_eq!(second.path, Path::new("a"));
        assert!(queue.pop().is_none());
    }

    #[test]
    fn raise_rescan_is_idempotent_until_delivered() {
        let queue = EventQueue::new(4);
        assert!(queue.raise_rescan());
        assert!(!queue.raise_rescan());
        assert!(queue.pop().is_some_and(|e| e.is_rescan()));
        assert!(queue.raise_rescan(), "a new episode can raise again");
    }

    #[test]
    fn invariant_holds_across_pushes_and_pops() {
        let queue = EventQueue::new(3);
        for i in 0..20 {
            let _ = queue.push(event(&format!("f{i}")));
            if i % 3 == 0 {
                let _ = queue.pop();
            }
            let (queued, _dropped, delivered, pending) = queue.snapshot();
            assert_eq!(
                queued,
                delivered + pending as u64,
                "queued == delivered + pending must hold at every step"
            );
        }
    }

    /// Ring slots currently allocated, which is what the shrink policy acts on.
    fn ring_capacity(queue: &EventQueue) -> usize {
        queue.state.lock().ring.capacity()
    }

    #[test]
    fn a_drained_burst_returns_its_buffer() {
        // The checkout-then-idle shape: a large tree changes at once, the consumer catches up, and
        // the process must not go on holding a full queue's worth of slots for the rest of its life.
        let queue = EventQueue::new(64 * RING_BASELINE);
        for i in 0..(8 * RING_BASELINE) {
            assert_eq!(queue.push(event(&format!("f{i}"))), Push::Accepted);
        }
        let peak = ring_capacity(&queue);
        assert!(
            peak >= 8 * RING_BASELINE,
            "the burst should have grown the ring"
        );

        while queue.pop().is_some() {}
        assert!(
            ring_capacity(&queue) <= RING_BASELINE,
            "ring held {} slots after draining, baseline is {RING_BASELINE}",
            ring_capacity(&queue)
        );
        assert!(queue.retained_bytes() < peak * std::mem::size_of::<FileEvent>());
    }

    #[test]
    fn a_queue_working_near_its_capacity_never_reallocates() {
        // Hysteresis: a steady-state queue whose ring is legitimately in use must not be shrunk on
        // every drain, or the shrink becomes its own allocation churn.
        let queue = EventQueue::new(RING_BASELINE * 2);
        for i in 0..RING_BASELINE {
            queue.push(event(&format!("f{i}")));
        }
        let settled = ring_capacity(&queue);
        for round in 0..20 {
            while queue.pop().is_some() {}
            for i in 0..RING_BASELINE {
                queue.push(event(&format!("r{round}-{i}")));
            }
            assert_eq!(
                ring_capacity(&queue),
                settled,
                "ring was reallocated during steady-state operation in round {round}"
            );
        }
    }

    #[test]
    fn a_small_queue_is_left_alone_entirely() {
        let queue = EventQueue::new(4);
        for i in 0..4 {
            queue.push(event(&format!("f{i}")));
        }
        let settled = ring_capacity(&queue);
        while queue.pop().is_some() {}
        assert_eq!(ring_capacity(&queue), settled);
    }

    #[test]
    fn retained_bytes_reflects_queued_paths_and_falls_back_after_draining() {
        let queue = EventQueue::new(16 * RING_BASELINE);
        let empty = queue.retained_bytes();
        for i in 0..(8 * RING_BASELINE) {
            queue.push(event(&format!("/a/deep/path/to/module{i}/index.ts")));
        }
        let loaded = queue.retained_bytes();
        assert!(loaded > empty);
        while queue.pop().is_some() {}
        assert!(
            queue.retained_bytes() <= empty,
            "drained queue holds {} bytes, more than the {empty} it started with",
            queue.retained_bytes()
        );
    }

    /// Randomised operation sequences against an independent model of the queue.
    ///
    /// The queue is small enough to specify completely — every operation's outcome is determined by
    /// the capacity and whether a rescan is pending — so these check exact agreement with a model
    /// rather than one-sided invariants. Overflow interleaved with draining is the part worth
    /// generating: it is where the rescan signal, the drop counter, and the ring's own bound meet.
    mod properties {
        use super::*;
        use proptest::prelude::*;

        #[derive(Debug, Clone)]
        enum Op {
            Push(u8),
            Pop,
            RaiseRescan,
        }

        fn op() -> impl Strategy<Value = Op> {
            prop_oneof![
                6 => any::<u8>().prop_map(Op::Push),
                4 => Just(Op::Pop),
                1 => Just(Op::RaiseRescan),
            ]
        }

        /// What the queue is specified to do, tracked independently of what it does do.
        #[derive(Default)]
        struct Model {
            ring: VecDeque<u8>,
            rescan_pending: bool,
            queued: u64,
            dropped: u64,
            delivered: u64,
        }

        proptest! {
            #[test]
            fn the_queue_agrees_with_its_specification(
                capacity in 1usize..24,
                ops in prop::collection::vec(op(), 1..500),
            ) {
                let queue = EventQueue::new(capacity);
                let mut model = Model::default();

                for op in ops {
                    match op {
                        Op::Push(tag) => {
                            let outcome = queue.push(event(&tag.to_string()));
                            if model.ring.len() >= capacity {
                                model.dropped += 1;
                                let raised = !model.rescan_pending;
                                if raised {
                                    model.rescan_pending = true;
                                    model.queued += 1;
                                }
                                prop_assert_eq!(
                                    outcome,
                                    Push::Overflow { rescan_raised: raised }
                                );
                            } else {
                                model.ring.push_back(tag);
                                model.queued += 1;
                                prop_assert_eq!(outcome, Push::Accepted);
                            }
                        }
                        Op::Pop => {
                            let got = queue.pop();
                            if model.rescan_pending {
                                model.rescan_pending = false;
                                model.delivered += 1;
                                prop_assert!(
                                    got.is_some_and(|e| e.is_rescan()),
                                    "a pending rescan must be delivered ahead of queued events"
                                );
                            } else if let Some(tag) = model.ring.pop_front() {
                                model.delivered += 1;
                                prop_assert_eq!(
                                    got.map(|e| e.path.to_string_lossy().into_owned()),
                                    Some(tag.to_string()),
                                    "events must come back in the order they were accepted"
                                );
                            } else {
                                prop_assert!(got.is_none(), "an empty queue produced an event");
                            }
                        }
                        Op::RaiseRescan => {
                            let raised = queue.raise_rescan();
                            prop_assert_eq!(raised, !model.rescan_pending);
                            if raised {
                                model.rescan_pending = true;
                                model.queued += 1;
                            }
                        }
                    }

                    let (queued, dropped, delivered, pending) = queue.snapshot();
                    prop_assert_eq!(queued, model.queued);
                    prop_assert_eq!(dropped, model.dropped);
                    prop_assert_eq!(delivered, model.delivered);
                    prop_assert_eq!(
                        pending,
                        model.ring.len() + usize::from(model.rescan_pending)
                    );
                    prop_assert_eq!(queued, delivered + pending as u64);
                    prop_assert!(
                        pending <= capacity + 1,
                        "pending {} exceeded capacity {} plus the out-of-band rescan slot",
                        pending,
                        capacity
                    );
                }
            }

            #[test]
            fn the_ring_never_retains_more_than_a_burst_needed(
                capacity in 1usize..(8 * RING_BASELINE),
                burst in 1usize..(4 * RING_BASELINE),
            ) {
                // Memory, not behaviour: however large the burst, a drained queue must fall back to
                // its baseline, and a loaded one must never allocate beyond what capacity permits.
                let queue = EventQueue::new(capacity);
                for i in 0..burst {
                    queue.push(event(&i.to_string()));
                }
                let loaded = queue.state.lock().ring.capacity();
                prop_assert!(
                    loaded >= burst.min(capacity),
                    "ring of {} slots cannot hold the {} events it accepted",
                    loaded,
                    burst.min(capacity)
                );

                while queue.pop().is_some() {}
                let drained = queue.state.lock().ring.capacity();
                prop_assert!(
                    drained <= capacity.min(RING_BASELINE) * RING_SHRINK_FACTOR,
                    "drained ring kept {} slots for a capacity of {}",
                    drained,
                    capacity
                );
            }
        }
    }

    #[test]
    fn pop_wait_returns_none_promptly_when_inactive() {
        let queue = EventQueue::new(4);
        let start = Instant::now();
        assert!(queue.pop_wait(Duration::from_secs(30)).is_none());
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "an inactive queue must not make the caller wait out the timeout"
        );
    }

    #[test]
    fn pop_wait_times_out_when_active_but_empty() {
        let queue = EventQueue::new(4);
        queue.set_active(true);
        let start = Instant::now();
        assert!(queue.pop_wait(Duration::from_millis(50)).is_none());
        assert!(start.elapsed() >= Duration::from_millis(40));
    }

    #[test]
    fn pop_wait_wakes_on_push() {
        let queue = Arc::new(EventQueue::new(4));
        queue.set_active(true);
        let producer = Arc::clone(&queue);
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            producer.push(event("late"));
        });
        let got = queue.pop_wait(Duration::from_secs(5));
        assert_eq!(got.map(|e| e.path), Some("late".into()));
        handle.join().expect("producer thread");
    }

    #[test]
    fn pop_wait_wakes_when_deactivated() {
        let queue = Arc::new(EventQueue::new(4));
        queue.set_active(true);
        let stopper = Arc::clone(&queue);
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            stopper.set_active(false);
        });
        let start = Instant::now();
        assert!(queue.pop_wait(Duration::from_secs(30)).is_none());
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "deactivating must wake blocked consumers"
        );
        handle.join().expect("stopper thread");
    }

    #[test]
    fn concurrent_producers_and_consumers_keep_counters_consistent() {
        let queue = Arc::new(EventQueue::new(16));
        queue.set_active(true);
        let mut handles = Vec::new();
        for producer in 0..4 {
            let queue = Arc::clone(&queue);
            handles.push(thread::spawn(move || {
                for i in 0..500 {
                    queue.push(event(&format!("p{producer}-{i}")));
                }
            }));
        }
        for _ in 0..3 {
            let queue = Arc::clone(&queue);
            handles.push(thread::spawn(move || {
                for _ in 0..500 {
                    let _ = queue.pop();
                }
            }));
        }
        for handle in handles {
            handle.join().expect("worker thread");
        }

        let (queued, dropped, delivered, pending) = queue.snapshot();
        assert_eq!(queued, delivered + pending as u64);
        // Every push increments exactly one of `queued` (accepted) or `dropped` (overflow); an
        // overflow that raises a fresh rescan signal additionally increments `queued`. So the
        // sum is at least the number of pushes, and never less.
        assert!(
            queued + dropped >= 4 * 500,
            "queued={queued} dropped={dropped} accounts for fewer than the 2000 pushes"
        );
        assert!(dropped <= 4 * 500);
    }
}

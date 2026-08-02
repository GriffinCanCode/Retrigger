//! Include/exclude filtering applied *before* events reach the queue.

use std::path::Path;

use globset::{Glob, GlobBuilder, GlobSet, GlobSetBuilder};
use regex::Regex;

use crate::error::WatchError;

/// Glob- and regex-based path filter.
///
/// Filtering happens on the backend thread, before an event is queued or broadcast, so a
/// filtered event costs nothing downstream and never occupies queue capacity. That is
/// observable through [`WatcherStats::events_queued`](crate::WatcherStats::events_queued).
///
/// # Semantics
///
/// A path passes when **no** exclude pattern matches it *and* (the include set is empty **or**
/// some include pattern matches it). Excludes win over includes.
///
/// Globs are matched against the whole path with [`globset`], so `**` crosses directory
/// separators and `*` does not. Because event paths are absolute, patterns generally want a
/// leading `**/`, e.g. `**/node_modules/**`.
///
/// # Examples
///
/// ```
/// use retrigger_system::EventFilter;
/// use std::path::Path;
///
/// let filter = EventFilter::new()
///     .include_glob("**/*.rs")?
///     .exclude_glob("**/target/**")?;
///
/// assert!(filter.matches(Path::new("/proj/src/main.rs")));
/// assert!(!filter.matches(Path::new("/proj/target/debug/build.rs")));
/// assert!(!filter.matches(Path::new("/proj/README.md")));
/// # Ok::<(), retrigger_system::WatchError>(())
/// ```
#[derive(Debug, Clone, Default)]
pub struct EventFilter {
    include_globs: Vec<Glob>,
    exclude_globs: Vec<Glob>,
    include_set: Option<GlobSet>,
    exclude_set: Option<GlobSet>,
    include_res: Vec<Regex>,
    exclude_res: Vec<Regex>,
}

impl EventFilter {
    /// An empty filter: every path passes.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Excludes that are almost always right for a JavaScript/Rust project tree.
    ///
    /// Deliberately *not* the default for [`WatcherConfig`](crate::WatcherConfig): a watcher
    /// that silently swallows paths nobody asked it to swallow is the failure mode this crate
    /// exists to remove. Opt in explicitly.
    ///
    /// Covers `node_modules`, `.git`, Rust `target`, common build output directories, and
    /// editor scratch files.
    ///
    /// # Errors
    ///
    /// Only if one of the built-in patterns fails to compile, which cannot happen with the
    /// bundled [`globset`] version; the `Result` exists so this never panics.
    pub fn dev_defaults() -> Result<Self, WatchError> {
        let mut filter = Self::new();
        for pattern in [
            "**/node_modules/**",
            "**/.git/**",
            "**/target/**",
            "**/dist/**",
            "**/.next/**",
            "**/*.tmp",
            "**/*.swp",
            "**/*~",
            "**/.DS_Store",
        ] {
            filter = filter.exclude_glob(pattern)?;
        }
        Ok(filter)
    }

    /// Add a glob a path must match to pass.
    ///
    /// # Errors
    ///
    /// [`WatchError::InvalidPattern`] if the glob does not compile.
    pub fn include_glob(mut self, pattern: &str) -> Result<Self, WatchError> {
        self.include_globs.push(compile_glob(pattern)?);
        self.include_set = Some(build_set(&self.include_globs)?);
        Ok(self)
    }

    /// Add a glob that rejects a path.
    ///
    /// # Errors
    ///
    /// [`WatchError::InvalidPattern`] if the glob does not compile.
    pub fn exclude_glob(mut self, pattern: &str) -> Result<Self, WatchError> {
        self.exclude_globs.push(compile_glob(pattern)?);
        self.exclude_set = Some(build_set(&self.exclude_globs)?);
        Ok(self)
    }

    /// Add a regular expression a path must match (unanchored) to pass.
    ///
    /// # Errors
    ///
    /// [`WatchError::InvalidPattern`] if the expression does not compile.
    pub fn include_regex(mut self, pattern: &str) -> Result<Self, WatchError> {
        self.include_res.push(compile_regex(pattern)?);
        Ok(self)
    }

    /// Add a regular expression that rejects a path (unanchored).
    ///
    /// # Errors
    ///
    /// [`WatchError::InvalidPattern`] if the expression does not compile.
    pub fn exclude_regex(mut self, pattern: &str) -> Result<Self, WatchError> {
        self.exclude_res.push(compile_regex(pattern)?);
        Ok(self)
    }

    /// Convenience constructor from two lists of globs, as a config file would supply them.
    ///
    /// # Errors
    ///
    /// [`WatchError::InvalidPattern`] if any glob does not compile.
    pub fn from_globs<I, E>(include: I, exclude: E) -> Result<Self, WatchError>
    where
        I: IntoIterator,
        I::Item: AsRef<str>,
        E: IntoIterator,
        E::Item: AsRef<str>,
    {
        let mut filter = Self::new();
        for pattern in include {
            filter = filter.include_glob(pattern.as_ref())?;
        }
        for pattern in exclude {
            filter = filter.exclude_glob(pattern.as_ref())?;
        }
        Ok(filter)
    }

    /// Whether no patterns are configured at all, in which case every path passes.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.include_globs.is_empty()
            && self.exclude_globs.is_empty()
            && self.include_res.is_empty()
            && self.exclude_res.is_empty()
    }

    /// Whether `path` passes the filter.
    #[must_use]
    pub fn matches(&self, path: &Path) -> bool {
        if self.is_empty() {
            return true;
        }
        if self.excludes(path) {
            return false;
        }

        // Regexes operate on the lossy string form; a non-UTF-8 path simply cannot match a
        // pattern written as UTF-8, and replacement characters cannot resurrect one.
        let as_str = path.to_string_lossy();
        let has_includes = !self.include_globs.is_empty() || !self.include_res.is_empty();
        if !has_includes {
            return true;
        }

        self.include_set
            .as_ref()
            .is_some_and(|set| set.is_match(path))
            || self.include_res.iter().any(|re| re.is_match(&as_str))
    }

    /// Whether `path` is *rejected* by an exclude pattern, ignoring the include set.
    ///
    /// This is the question to ask about a **directory** when deciding whether to look inside it,
    /// because includes describe the files a consumer wants, not the directories those files live
    /// in: `**/*.rs` does not match `src/`, yet `src/` obviously has to be descended into. Asking
    /// [`matches`](Self::matches) about a directory would prune the whole subtree.
    ///
    /// ```
    /// use retrigger_system::EventFilter;
    /// use std::path::Path;
    ///
    /// let filter = EventFilter::new()
    ///     .include_glob("**/*.rs")?
    ///     .exclude_glob("**/target/**")?;
    ///
    /// assert!(!filter.matches(Path::new("/p/src")));   // not a *.rs file
    /// assert!(!filter.excludes(Path::new("/p/src")));  // but not excluded either — descend
    /// assert!(filter.excludes(Path::new("/p/target/debug")));
    /// # Ok::<(), retrigger_system::WatchError>(())
    /// ```
    #[must_use]
    pub fn excludes(&self, path: &Path) -> bool {
        if self.exclude_globs.is_empty() && self.exclude_res.is_empty() {
            return false;
        }
        if self
            .exclude_set
            .as_ref()
            .is_some_and(|set| set.is_match(path))
        {
            return true;
        }
        let as_str = path.to_string_lossy();
        self.exclude_res.iter().any(|re| re.is_match(&as_str))
    }
}

fn compile_glob(pattern: &str) -> Result<Glob, WatchError> {
    // `literal_separator` is what makes `*` stop at a path boundary while `**` crosses it. Without
    // it `src/*.rs` would also match `src/a/b.rs`, which is not what anyone writing that pattern
    // means.
    GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map_err(|e| WatchError::InvalidPattern(format!("glob `{pattern}`: {e}")))
}

fn compile_regex(pattern: &str) -> Result<Regex, WatchError> {
    Regex::new(pattern).map_err(|e| WatchError::InvalidPattern(format!("regex `{pattern}`: {e}")))
}

fn build_set(globs: &[Glob]) -> Result<GlobSet, WatchError> {
    let mut builder = GlobSetBuilder::new();
    for glob in globs {
        builder.add(glob.clone());
    }
    builder
        .build()
        .map_err(|e| WatchError::InvalidPattern(format!("glob set: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> &Path {
        Path::new(s)
    }

    #[test]
    fn empty_filter_passes_everything() {
        let filter = EventFilter::new();
        assert!(filter.is_empty());
        assert!(filter.matches(p("/anything/at/all")));
        assert!(filter.matches(p("")));
    }

    #[test]
    fn include_glob_restricts() -> Result<(), WatchError> {
        let filter = EventFilter::new().include_glob("**/*.rs")?;
        assert!(filter.matches(p("/proj/src/main.rs")));
        assert!(!filter.matches(p("/proj/src/main.js")));
        Ok(())
    }

    #[test]
    fn exclude_beats_include() -> Result<(), WatchError> {
        let filter = EventFilter::new()
            .include_glob("**/*.js")?
            .exclude_glob("**/node_modules/**")?;
        assert!(filter.matches(p("/proj/src/app.js")));
        assert!(!filter.matches(p("/proj/node_modules/react/index.js")));
        Ok(())
    }

    #[test]
    fn excludes_answers_only_the_exclusion_question() -> Result<(), WatchError> {
        let filter = EventFilter::new()
            .include_glob("**/*.rs")?
            .exclude_glob("**/target/**")?;

        // A directory fails `matches` for want of an include, which is why deciding whether to look
        // inside one has to ask `excludes` instead.
        assert!(!filter.matches(p("/proj/src")));
        assert!(!filter.excludes(p("/proj/src")));

        assert!(filter.excludes(p("/proj/target/debug/x.rs")));
        assert!(!filter.matches(p("/proj/target/debug/x.rs")));
        Ok(())
    }

    #[test]
    fn excludes_covers_regexes_and_is_false_without_any() -> Result<(), WatchError> {
        assert!(!EventFilter::new().excludes(p("/anything")));
        assert!(!EventFilter::new()
            .include_glob("**/*.rs")?
            .excludes(p("/proj/notes.md")));

        let filter = EventFilter::new().exclude_regex(r"\.min\.js$")?;
        assert!(filter.excludes(p("/proj/vendor/jquery.min.js")));
        assert!(!filter.excludes(p("/proj/src/app.js")));
        Ok(())
    }

    #[test]
    fn double_star_crosses_separators_and_single_star_does_not() -> Result<(), WatchError> {
        let deep = EventFilter::new().include_glob("/proj/**/*.rs")?;
        assert!(deep.matches(p("/proj/a/b/c/x.rs")));

        let shallow = EventFilter::new().include_glob("/proj/*.rs")?;
        assert!(shallow.matches(p("/proj/x.rs")));
        assert!(!shallow.matches(p("/proj/a/x.rs")));
        Ok(())
    }

    #[test]
    fn node_modules_exclusion_matches_at_any_depth() -> Result<(), WatchError> {
        let filter = EventFilter::new().exclude_glob("**/node_modules/**")?;
        for excluded in [
            "/node_modules/x.js",
            "/proj/node_modules/x.js",
            "/proj/a/b/node_modules/pkg/dist/x.js",
        ] {
            assert!(
                !filter.matches(p(excluded)),
                "{excluded} should be excluded"
            );
        }
        // The directory itself has nothing after the separator, so it is not matched by
        // `node_modules/**`. Callers that want the directory event gone too must add
        // `**/node_modules` as well; asserted here so the behaviour is pinned rather than
        // assumed.
        assert!(filter.matches(p("/proj/node_modules")));
        Ok(())
    }

    #[test]
    fn dev_defaults_exclude_the_usual_suspects() -> Result<(), WatchError> {
        let filter = EventFilter::dev_defaults()?;
        for excluded in [
            "/p/node_modules/react/index.js",
            "/p/.git/HEAD",
            "/p/target/debug/deps/x.rlib",
            "/p/dist/bundle.js",
            "/p/.next/cache/x",
            "/p/src/a.tmp",
            "/p/src/.a.swp",
            "/p/src/a.rs~",
            "/p/.DS_Store",
        ] {
            assert!(
                !filter.matches(p(excluded)),
                "{excluded} should be excluded"
            );
        }
        for allowed in ["/p/src/main.rs", "/p/index.js", "/p/.env"] {
            assert!(filter.matches(p(allowed)), "{allowed} should be allowed");
        }
        Ok(())
    }

    #[test]
    fn regex_filters_work_alongside_globs() -> Result<(), WatchError> {
        let filter = EventFilter::new().exclude_regex(r"\.(log|bak)$")?;
        assert!(!filter.matches(p("/p/x.log")));
        assert!(!filter.matches(p("/p/x.bak")));
        assert!(filter.matches(p("/p/x.rs")));

        let only_tests = EventFilter::new().include_regex(r"/tests?/")?;
        assert!(only_tests.matches(p("/p/tests/a.rs")));
        assert!(!only_tests.matches(p("/p/src/a.rs")));
        Ok(())
    }

    #[test]
    fn include_glob_or_include_regex_is_enough() -> Result<(), WatchError> {
        let filter = EventFilter::new()
            .include_glob("**/*.rs")?
            .include_regex(r"\.toml$")?;
        assert!(filter.matches(p("/p/a.rs")));
        assert!(filter.matches(p("/p/Cargo.toml")));
        assert!(!filter.matches(p("/p/a.md")));
        Ok(())
    }

    #[test]
    fn multiple_includes_are_a_union() -> Result<(), WatchError> {
        let filter = EventFilter::new()
            .include_glob("**/*.rs")?
            .include_glob("**/*.toml")?;
        assert!(filter.matches(p("/p/a.rs")));
        assert!(filter.matches(p("/p/a.toml")));
        assert!(!filter.matches(p("/p/a.md")));
        Ok(())
    }

    #[test]
    fn invalid_patterns_are_reported_not_panicked() {
        let err = EventFilter::new().include_glob("a[").unwrap_err();
        assert!(matches!(err, WatchError::InvalidPattern(_)), "{err:?}");

        let err = EventFilter::new().exclude_regex("(unclosed").unwrap_err();
        assert!(matches!(err, WatchError::InvalidPattern(_)), "{err:?}");
    }

    #[test]
    fn paths_with_glob_metacharacters_are_matched_literally() -> Result<(), WatchError> {
        let filter = EventFilter::new().include_glob("**/*.txt")?;
        assert!(filter.matches(p("/p/we [ird] (name) {x}.txt")));
        assert!(filter.matches(p("/p/star*name.txt")));
        Ok(())
    }

    #[test]
    fn non_ascii_paths_match() -> Result<(), WatchError> {
        let filter = EventFilter::new().include_glob("**/*.txt")?;
        assert!(filter.matches(p("/p/テスト ファイル 🚀.txt")));
        Ok(())
    }

    #[test]
    fn from_globs_builds_both_sides() -> Result<(), WatchError> {
        let filter = EventFilter::from_globs(["**/*.js"], ["**/node_modules/**"])?;
        assert!(filter.matches(p("/p/a.js")));
        assert!(!filter.matches(p("/p/node_modules/a.js")));
        assert!(!filter.matches(p("/p/a.rs")));
        Ok(())
    }

    #[test]
    fn filter_is_clonable_and_independent() -> Result<(), WatchError> {
        let base = EventFilter::new().exclude_glob("**/a/**")?;
        let extended = base.clone().exclude_glob("**/b/**")?;
        assert!(base.matches(p("/x/b/c")));
        assert!(!extended.matches(p("/x/b/c")));
        Ok(())
    }
}

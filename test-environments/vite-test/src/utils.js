export function updateContent(message) {
    const contentDiv = document.getElementById('content');
    if (contentDiv) {
        contentDiv.innerHTML = `
            <p><strong>${message}</strong></p>
            <p><em>Last updated: ${new Date().toLocaleTimeString()}</em></p>
        `;
    }
}

export function setupButton() {
    const button = document.getElementById('btn');
    if (button) {
        button.onclick = () => {
            updateContent('Vite HMR button clicked! Retrigger + Vite working 🚀');
        };
    }
}

export async function fetchRetriggerStats() {
    try {
        // Try to fetch Retrigger stats from the plugin endpoint
        const response = await fetch('/__retrigger_stats');
        if (response.ok) {
            const stats = await response.json();
            displayStats(stats);
        }
    } catch (error) {
        console.log('Could not fetch Retrigger stats:', error);
    }
}

function displayStats(stats) {
    const statsDiv = document.getElementById('stats');
    if (statsDiv && stats) {
        statsDiv.innerHTML = `
            <div class="stats-container">
                <h3>🔥 Retrigger Performance Stats</h3>
                <div class="stat-item">SIMD Level: <span>${stats.simd_level}</span></div>
                <div class="stat-item">Watched Directories: <span>${stats.watched_directories}</span></div>
                <div class="stat-item">Total Events: <span>${stats.total_events}</span></div>
                ${stats.hmr ? `
                    <div class="stat-item">HMR Updates: <span>${stats.hmr.updates}</span></div>
                    <div class="stat-item">Avg Update Time: <span>${stats.hmr.average_update_time_ms?.toFixed(1)}ms</span></div>
                ` : ''}
            </div>
        `;
    }
}

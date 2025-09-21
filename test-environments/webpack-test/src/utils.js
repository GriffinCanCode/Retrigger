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
            updateContent('Button clicked! Retrigger is working 🚀');
        };
    }
}

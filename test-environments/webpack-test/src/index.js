import { updateContent, setupButton } from './utils';
import './styles.css';

console.log('Retrigger Webpack Plugin Test - Initial load');

// Initialize the app
function init() {
    updateContent('App initialized with Retrigger!');
    setupButton();
    
    // Show that we're using the Retrigger plugin
    console.log('✅ Webpack with Retrigger plugin loaded successfully');
}

// Run initialization
init();

// Test hot module replacement
if (module.hot) {
    module.hot.accept('./utils', function() {
        console.log('🔥 Hot reload triggered by Retrigger!');
        init();
    });
}

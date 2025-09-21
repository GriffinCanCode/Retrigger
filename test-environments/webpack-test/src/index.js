import { updateContent, setupButton } from './utils';
import { 
  updateTestContent, 
  incrementCounter, 
  measureWebpackUpdateTime,
  webpackTestInstructions 
} from './hot-reload-test.js';
import { globalWebpackStressTest, webpackPerformanceTest } from './webpack-stress-test.js';
import './styles.css';

console.log('Retrigger Webpack Plugin Test - Initial load');
console.log(webpackTestInstructions);

// Initialize the app
function init() {
    updateContent('Webpack with Retrigger plugin initialized!');
    setupButton();
    
    // Initialize webpack hot reload test
    updateTestContent();

    // Add test content areas if they don't exist
    if (!document.getElementById('webpack-test-content')) {
      const testDiv = document.createElement('div');
      testDiv.id = 'webpack-test-content';
      document.body.appendChild(testDiv);
      updateTestContent();
    }

    // Add webpack stress test component
    if (!document.getElementById('webpack-stress-test')) {
      const stressDiv = document.createElement('div');
      stressDiv.id = 'webpack-stress-test';
      stressDiv.innerHTML = globalWebpackStressTest.render();
      document.body.appendChild(stressDiv);
    }
    
    // Show that we're using the Retrigger plugin
    console.log('✅ Webpack with Retrigger plugin loaded successfully');
    console.log('🧪 Webpack Hot Reload Test: Edit hot-reload-test.js to test performance!');
}

// Run initialization
init();

// Test hot module replacement with performance tracking
if (module.hot) {
    module.hot.accept('./utils', function() {
        console.log('🔥 Hot reload triggered by Retrigger for utils!');
        init();
    });

    module.hot.accept('./hot-reload-test.js', function() {
        const measure = measureWebpackUpdateTime();
        console.log('🔥 HMR triggered by Retrigger for hot-reload-test.js!');
        
        // Update test content with performance measurement
        updateTestContent();
        const perf = measure();
        console.log(`⚡ Webpack hot reload performance: ${perf.currentUpdate.toFixed(2)}ms`);
    });

    module.hot.accept('./webpack-stress-test.js', function() {
        const measure = measureWebpackUpdateTime();
        console.log('🔥 HMR triggered by Retrigger for webpack-stress-test.js!');
        
        // Update stress test component
        const stressDiv = document.getElementById('webpack-stress-test');
        if (stressDiv) {
            stressDiv.innerHTML = globalWebpackStressTest.render();
        }
        const perf = measure();
        console.log(`⚡ Webpack stress test HMR: ${perf.currentUpdate.toFixed(2)}ms`);
        
        // Run performance test
        const processTime = webpackPerformanceTest();
        console.log(`🧪 Webpack complex operations: ${processTime.toFixed(2)}ms`);
    });
}

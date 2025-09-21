import { updateContent, setupButton, fetchRetriggerStats } from './utils.js';
import { 
  updateTestContent, 
  incrementCounter, 
  measureUpdateTime,
  testInstructions 
} from './hot-reload-test.js';
import { globalStressTest, performanceTest } from './stress-test.js';
import './style.css';

console.log('Retrigger Vite Plugin Test - Initial load');
console.log(testInstructions);

// Initialize the app
async function init() {
    updateContent('Vite with Retrigger initialized!');
    setupButton();
    
    // Initialize hot reload test
    updateTestContent();
    
    // Add test content area if not exists
    const app = document.getElementById('app');
    if (app && !document.getElementById('test-content')) {
      const testDiv = document.createElement('div');
      testDiv.id = 'test-content';
      app.appendChild(testDiv);
      updateTestContent();
    }
    
    // Add stress test component
    if (app && !document.getElementById('stress-test')) {
      const stressDiv = document.createElement('div');
      stressDiv.id = 'stress-test';
      stressDiv.innerHTML = globalStressTest.render();
      app.appendChild(stressDiv);
    }
    
    // Fetch and display Retrigger stats if available
    try {
        await fetchRetriggerStats();
    } catch (error) {
        console.log('Retrigger stats not available yet:', error.message);
    }
    
    console.log('✅ Vite with Retrigger plugin loaded successfully');
    console.log('🧪 Hot Reload Test: Edit hot-reload-test.js to test performance!');
}

// Run initialization
init();

// Hot Module Replacement (HMR) - Vite API
if (import.meta.hot) {
    import.meta.hot.accept('./utils.js', (newModule) => {
        console.log('🔥 HMR triggered by Retrigger for utils.js!');
        if (newModule) {
            // Re-run with new module
            newModule.updateContent('Hot module replacement working with Retrigger! 🚀');
            newModule.setupButton();
        }
    });

    import.meta.hot.accept('./hot-reload-test.js', (newModule) => {
        const measure = measureUpdateTime();
        console.log('🔥 HMR triggered by Retrigger for hot-reload-test.js!');
        
        if (newModule) {
            // Update test content with performance measurement
            newModule.updateTestContent();
            const perf = measure();
            console.log(`⚡ Hot reload performance: ${perf.currentUpdate.toFixed(2)}ms`);
        }
    });

    import.meta.hot.accept('./stress-test.js', (newModule) => {
        const measure = measureUpdateTime();
        console.log('🔥 HMR triggered by Retrigger for stress-test.js!');
        
        if (newModule) {
            // Update stress test component
            const stressDiv = document.getElementById('stress-test');
            if (stressDiv) {
                stressDiv.innerHTML = newModule.globalStressTest.render();
            }
            const perf = measure();
            console.log(`⚡ Stress test HMR: ${perf.currentUpdate.toFixed(2)}ms`);
            
            // Run performance test
            const processTime = newModule.performanceTest();
            console.log(`🧪 Complex operations: ${processTime.toFixed(2)}ms`);
        }
    });
}

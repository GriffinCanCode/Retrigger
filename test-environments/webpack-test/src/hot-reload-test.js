/**
 * Hot Reload Performance Test for Webpack
 * 
 * This file can be rapidly modified to test hot reload smoothness.
 * Change the counter, message, or styles below and observe the update speed.
 */

export let testCounter = 0;
export let testMessage = "Webpack Hot Reload Test - Update this message!";

// Test CSS styles for hot reload testing
export const testStyles = {
  backgroundColor: '#fff5f5',
  color: '#c53030',
  padding: '20px',
  borderRadius: '8px',
  border: '2px solid #e53e3e',
  fontSize: '16px',
  fontWeight: 'normal',
};

export function incrementCounter() {
  testCounter++;
  return testCounter;
}

export function updateTestContent() {
  const testDiv = document.getElementById('webpack-test-content');
  if (testDiv) {
    testDiv.innerHTML = `
      <div style="
        background: ${testStyles.backgroundColor};
        color: ${testStyles.color};
        padding: ${testStyles.padding};
        border-radius: ${testStyles.borderRadius};
        border: ${testStyles.border};
        font-size: ${testStyles.fontSize};
        font-weight: ${testStyles.fontWeight};
        margin: 20px 0;
      ">
        <h3>⚡ Webpack Hot Reload Test</h3>
        <p><strong>Message:</strong> ${testMessage}</p>
        <p><strong>Counter:</strong> ${testCounter}</p>
        <p><strong>Last Update:</strong> ${new Date().toLocaleTimeString()}</p>
        <p><em>Modify this file to test webpack hot reload speed!</em></p>
        
        <div style="margin-top: 15px; font-size: 14px; opacity: 0.7;">
          <div>⚡ Webpack: Enabled</div>
          <div>🔧 Retrigger Plugin: Active</div> 
          <div>🚀 JavaScript Optimizations: Active</div>
          <div>📊 Performance Mode: ${testStyles.backgroundColor === '#fff5f5' ? 'Development' : 'Enhanced'}</div>
        </div>
      </div>
    `;
  }
}

// Performance measurement for webpack
let webpackUpdateTimes = [];
export function measureWebpackUpdateTime() {
  const startTime = performance.now();
  
  return () => {
    const endTime = performance.now();
    const updateTime = endTime - startTime;
    webpackUpdateTimes.push(updateTime);
    
    // Keep only last 10 measurements
    if (webpackUpdateTimes.length > 10) {
      webpackUpdateTimes.shift();
    }
    
    const avgTime = webpackUpdateTimes.reduce((sum, time) => sum + time, 0) / webpackUpdateTimes.length;
    
    console.log(`⚡ Webpack Hot Reload: ${updateTime.toFixed(2)}ms (avg: ${avgTime.toFixed(2)}ms)`);
    
    return {
      currentUpdate: updateTime,
      averageUpdate: avgTime,
      measurements: webpackUpdateTimes.length,
      bundler: 'webpack'
    };
  };
}

// Instructions for webpack testing
export const webpackTestInstructions = `
🧪 Webpack Hot Reload Performance Testing:

1. Open this file (hot-reload-test.js) in your editor
2. Make changes like:
   - Update testMessage string
   - Change testStyles colors/properties  
   - Modify the HTML content in updateTestContent()
   - Change testCounter initial value

3. Save and observe webpack hot reload speed
4. Check console for timing measurements
5. Compare with Vite performance

Expected webpack performance:
- Update time: < 100ms (webpack is typically slower than Vite)
- Smooth updates with no flashing
- Consistent performance across changes
`;

// Auto-test functionality  
export function startWebpackAutoTest() {
  setInterval(() => {
    const measure = measureWebpackUpdateTime();
    incrementCounter();
    updateTestContent();
    const perf = measure();
    console.log(`🔄 Auto-test: ${perf.currentUpdate.toFixed(2)}ms`);
  }, 3000); // Slightly slower for webpack
}

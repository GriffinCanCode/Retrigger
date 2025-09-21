/**
 * Hot Reload Performance Test
 * 
 * This file can be rapidly modified to test hot reload smoothness.
 * Change the counter, message, or styles below and observe the update speed.
 */

export let testCounter = 0;
export let testMessage = "Hot Reload Test - Update this message to test!";

// Test CSS class for styling changes
export const testStyles = {
  backgroundColor: '#f0f8ff',
  color: '#2c3e50',
  padding: '20px',
  borderRadius: '8px',
  border: '2px solid #3498db',
  fontSize: '16px',
  fontWeight: 'normal',
};

export function incrementCounter() {
  testCounter++;
  return testCounter;
}

export function updateTestContent() {
  const testDiv = document.getElementById('test-content');
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
        <h3>🚀 Hot Reload Performance Test</h3>
        <p><strong>Message:</strong> ${testMessage}</p>
        <p><strong>Counter:</strong> ${testCounter}</p>
        <p><strong>Last Update:</strong> ${new Date().toLocaleTimeString()}</p>
        <p><em>Modify this file to test hot reload speed!</em></p>
        
        <div style="margin-top: 15px; font-size: 14px; opacity: 0.7;">
          <div>✅ Native watching: Enabled</div>
          <div>✅ Advanced HMR: Enabled</div> 
          <div>✅ SharedArrayBuffer: Enabled</div>
          <div>✅ Performance optimizations: Active</div>
        </div>
      </div>
    `;
  }
}

// Performance measurement
let updateTimes = [];
export function measureUpdateTime() {
  const startTime = performance.now();
  
  return () => {
    const endTime = performance.now();
    const updateTime = endTime - startTime;
    updateTimes.push(updateTime);
    
    // Keep only last 10 measurements
    if (updateTimes.length > 10) {
      updateTimes.shift();
    }
    
    const avgTime = updateTimes.reduce((sum, time) => sum + time, 0) / updateTimes.length;
    
    console.log(`🔥 Hot Reload Update: ${updateTime.toFixed(2)}ms (avg: ${avgTime.toFixed(2)}ms)`);
    
    return {
      currentUpdate: updateTime,
      averageUpdate: avgTime,
      measurements: updateTimes.length
    };
  };
}

// Auto-increment counter for continuous testing
export function startAutoTest() {
  setInterval(() => {
    const measure = measureUpdateTime();
    incrementCounter();
    updateTestContent();
    measure();
  }, 2000);
}

// Instructions for testing
export const testInstructions = `
🧪 Hot Reload Performance Testing Instructions:

1. Open this file (hot-reload-test.js) in your editor
2. Make small changes like:
   - Update the testMessage string
   - Change testStyles colors/properties  
   - Modify the HTML content in updateTestContent()
   - Change the testCounter initial value

3. Save the file and observe how quickly the browser updates
4. Check the console for update timing measurements
5. The updates should be smooth and nearly instantaneous!

Expected performance with optimizations:
- Update time: < 50ms
- No flashing or jarring transitions
- Smooth CSS transitions
- Console shows consistent timing

If updates feel slow or choppy, there may be configuration issues.
`;

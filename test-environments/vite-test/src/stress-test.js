/**
 * Stress Test for Hot Reload Performance
 * This file contains complex logic to test HMR under load
 */

export class StressTestComponent {
  constructor() {
    this.data = {
      items: Array.from({ length: 100 }, (_, i) => ({
        id: i,
        name: `Item ${i}`,
        value: Math.random() * 1000,
        timestamp: Date.now(),
      })),
      config: {
        theme: 'light',
        animations: true,
        performanceMode: 'optimized',
        cacheSize: 1024,
      },
      stats: {
        renders: 0,
        updates: 0,
        lastUpdate: null,
      }
    };
  }

  render() {
    this.data.stats.renders++;
    this.data.stats.lastUpdate = new Date().toLocaleTimeString();
    
    return `
      <div class="stress-test" style="
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 20px;
        border-radius: 10px;
        margin: 20px 0;
      ">
        <h3>🔥 Stress Test Component</h3>
        <div>Theme: ${this.data.config.theme}</div>
        <div>Performance Mode: ${this.data.config.performanceMode}</div>
        <div>Cache Size: ${this.data.config.cacheSize}MB</div>
        <div>Renders: ${this.data.stats.renders}</div>
        <div>Last Update: ${this.data.stats.lastUpdate}</div>
        
        <div style="margin-top: 15px;">
          <strong>Items (${this.data.items.length}):</strong>
          <div style="max-height: 200px; overflow-y: auto; margin-top: 10px;">
            ${this.data.items.slice(0, 10).map(item => 
              `<div style="padding: 5px; border-bottom: 1px solid rgba(255,255,255,0.2);">
                ${item.name}: ${item.value.toFixed(2)}
              </div>`
            ).join('')}
            ${this.data.items.length > 10 ? '<div>... and more</div>' : ''}
          </div>
        </div>
      </div>
    `;
  }

  updateConfig(newConfig) {
    this.data.config = { ...this.data.config, ...newConfig };
    this.data.stats.updates++;
  }
}

export const globalStressTest = new StressTestComponent();

// Performance test function
export function performanceTest() {
  const start = performance.now();
  
  // Simulate complex operations
  for (let i = 0; i < 1000; i++) {
    const item = globalStressTest.data.items[i % globalStressTest.data.items.length];
    item.value = Math.random() * 1000;
  }
  
  const end = performance.now();
  console.log(`⚡ Complex update processed in ${(end - start).toFixed(2)}ms`);
  
  return end - start;
}

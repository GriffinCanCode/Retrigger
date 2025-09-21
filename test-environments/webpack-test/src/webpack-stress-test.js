/**
 * Webpack Stress Test for Hot Reload Performance
 * Tests complex component updates and performance under load
 */

export class WebpackStressTestComponent {
  constructor() {
    this.data = {
      items: Array.from({ length: 50 }, (_, i) => ({
        id: i,
        name: `Webpack Item ${i}`,
        value: Math.random() * 500,
        timestamp: Date.now(),
        category: ['dev', 'prod', 'test'][i % 3],
      })),
      config: {
        theme: 'webpack-dark',
        bundler: 'webpack',
        hmrEnabled: true,
        performanceMode: 'optimized',
        cacheSize: 512,
      },
      stats: {
        renders: 0,
        hotUpdates: 0,
        lastUpdate: null,
        buildTime: 0,
      }
    };
  }

  render() {
    this.data.stats.renders++;
    this.data.stats.lastUpdate = new Date().toLocaleTimeString();
    
    return `
      <div class="webpack-stress-test" style="
        background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
        color: white;
        padding: 20px;
        border-radius: 10px;
        margin: 20px 0;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      ">
        <h3>⚡ Webpack Stress Test Component</h3>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin: 15px 0;">
          <div>Bundler: ${this.data.config.bundler}</div>
          <div>Theme: ${this.data.config.theme}</div>
          <div>HMR: ${this.data.config.hmrEnabled ? '✅ Enabled' : '❌ Disabled'}</div>
          <div>Cache: ${this.data.config.cacheSize}MB</div>
          <div>Renders: ${this.data.stats.renders}</div>
          <div>Hot Updates: ${this.data.stats.hotUpdates}</div>
        </div>
        
        <div style="margin-top: 15px;">
          <strong>Performance Test Items (${this.data.items.length}):</strong>
          <div style="max-height: 150px; overflow-y: auto; margin-top: 10px; background: rgba(0,0,0,0.2); border-radius: 5px; padding: 10px;">
            ${this.data.items.slice(0, 8).map(item => 
              `<div style="display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.1);">
                <span>${item.name}</span>
                <span style="color: #ffd700;">${item.category}</span>
                <span>${item.value.toFixed(1)}</span>
              </div>`
            ).join('')}
            ${this.data.items.length > 8 ? '<div style="text-align: center; padding: 5px;">... and more</div>' : ''}
          </div>
        </div>
        
        <div style="margin-top: 15px; font-size: 12px; opacity: 0.8;">
          Last Update: ${this.data.stats.lastUpdate} | Build Time: ${this.data.stats.buildTime}ms
        </div>
      </div>
    `;
  }

  updateConfig(newConfig) {
    this.data.config = { ...this.data.config, ...newConfig };
    this.data.stats.hotUpdates++;
    this.data.stats.buildTime = Math.random() * 100 + 20; // Simulate build time
  }

  addItems(count = 5) {
    const currentLength = this.data.items.length;
    for (let i = 0; i < count; i++) {
      this.data.items.push({
        id: currentLength + i,
        name: `Dynamic Item ${currentLength + i}`,
        value: Math.random() * 1000,
        timestamp: Date.now(),
        category: ['new', 'dynamic', 'test'][i % 3],
      });
    }
  }
}

export const globalWebpackStressTest = new WebpackStressTestComponent();

// Webpack-specific performance test
export function webpackPerformanceTest() {
  const start = performance.now();
  
  // Simulate webpack-style operations
  for (let i = 0; i < 500; i++) {
    const item = globalWebpackStressTest.data.items[i % globalWebpackStressTest.data.items.length];
    item.value = Math.random() * 500;
    item.timestamp = Date.now();
  }
  
  // Update config
  globalWebpackStressTest.updateConfig({
    performanceMode: Math.random() > 0.5 ? 'enhanced' : 'standard',
    cacheSize: Math.floor(Math.random() * 1000) + 100,
  });
  
  const end = performance.now();
  const duration = end - start;
  
  console.log(`⚡ Webpack complex update: ${duration.toFixed(2)}ms`);
  
  return duration;
}

// Webpack hot reload simulation
export function simulateWebpackHMR() {
  console.log('🔄 Simulating Webpack HMR...');
  
  globalWebpackStressTest.addItems(3);
  globalWebpackStressTest.updateConfig({
    theme: globalWebpackStressTest.data.config.theme === 'webpack-dark' ? 'webpack-light' : 'webpack-dark',
  });
  
  return globalWebpackStressTest.render();
}

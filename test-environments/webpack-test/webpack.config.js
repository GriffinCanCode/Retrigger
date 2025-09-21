const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const RetriggerWebpackPlugin = require('@retrigger/core/plugins/webpack-plugin');

module.exports = {
  entry: './src/index.js',
  mode: 'development',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/index.html',
      filename: 'index.html',
    }),
    new RetriggerWebpackPlugin({
      verbose: true,
      watchPaths: [path.resolve(__dirname, 'src')],
      debounceMs: 25, // Reduced debounce for smoother updates
      useSharedBuffer: false, // Temporarily disable due to native binding issues
      enableAdvancedInvalidation: true, // Smart module invalidation (JS-based)
      enableNativeWatching: false, // Temporarily disable due to Rust binding issues
      maxEventBatch: 100, // Prevent overwhelming with too many events
      // Note: Using JavaScript-based optimizations while native bindings are fixed
    }),
  ],
  devtool: 'inline-source-map',
  devServer: {
    port: 3001,
    open: true,
    hot: true,
    static: {
      directory: path.resolve(__dirname, 'dist'),
    },
  },
};

import { createApp } from 'vue'
import App from './App.vue'
import './styles/globals.css'

/**
 * Mount the observability dashboard Vue app.
 *
 * Why: Single mount point keeps the bootstrap minimal.
 * All composition happens in App.vue + composables.
 */
createApp(App).mount('#app')

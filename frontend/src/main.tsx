import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import SUPERATOM from './superatom.ts'
import './data/query.ts' // Initialize QueryExecutor
import './data/actions.ts' // Initialize Actions handlers
import './data/tool-executor.ts' // Initialize ToolExecutor for external tools


// Not 'root': when this bundle is loaded into a host app (e.g. @superatomai/application-react),
// a host container with the common id "root" would get replaced by this app.
const root = document.getElementById('sa-root');
if(root){
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

// Initialize Superatom before rendering
SUPERATOM.init()

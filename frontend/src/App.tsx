import { BrowserRouter, Routes, Route } from 'react-router-dom';
// import DatabaseQueryDemo from './components/DatabaseQueryDemo';
import Showcase from './pages/Showcase';
import ComponentShowcase from './pages/ComponentShowcase';
import DashBuilderDev from './pages/DashBuilderDev';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* <Route path="/showcase" element={<DatabaseQueryDemo />} /> */}
        <Route path="/showcase" element={<Showcase />} />
        <Route path="/components" element={<ComponentShowcase />} />
        {/* Program-generated dashboards. Separate from the JSON-DSL pages. */}
        <Route path="/dash-builder" element={<DashBuilderDev />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;

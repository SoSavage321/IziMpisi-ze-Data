import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './hooks/auth.tsx';
import { AppShell } from './components/shell.tsx';
import { Spinner } from './components/ui.tsx';

import Login from './pages/Login.tsx';
import Fleet from './pages/Fleet.tsx';
import SiteLive from './pages/SiteLive.tsx';
import Control from './pages/Control.tsx';
import Alarms from './pages/Alarms.tsx';
import Batches from './pages/Batches.tsx';
import BatchDetail from './pages/BatchDetail.tsx';
import Analytics from './pages/Analytics.tsx';
import Reports from './pages/Reports.tsx';
import Maintenance from './pages/Maintenance.tsx';
import Inventory from './pages/Inventory.tsx';
import Logbook from './pages/Logbook.tsx';
import Settings from './pages/Settings.tsx';
import Audit from './pages/Audit.tsx';
import Simulation from './pages/Simulation.tsx';
import About from './pages/About.tsx';

export default function App() {
  const { session, loading, role } = useAuth();

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner label="Signing in" /></div>;
  if (!session) return <Routes><Route path="*" element={<Login />} /></Routes>;

  const adminOnly = (element: JSX.Element) =>
    role === 'admin' ? element : <Navigate to="/" replace />;

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Fleet />} />
        <Route path="/device/:deviceId" element={<SiteLive />} />
        <Route path="/device/:deviceId/control" element={<Control />} />
        <Route path="/alarms" element={<Alarms />} />
        <Route path="/batches" element={<Batches />} />
        <Route path="/batches/:batchId" element={<BatchDetail />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/maintenance" element={<Maintenance />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/logbook" element={<Logbook />} />
        <Route path="/settings" element={adminOnly(<Settings />)} />
        <Route path="/audit" element={adminOnly(<Audit />)} />
        <Route path="/simulation" element={<Simulation />} />
        <Route path="/about" element={<About />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

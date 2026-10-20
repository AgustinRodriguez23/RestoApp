import { Link, Route, Routes } from 'react-router-dom';
import { Layout, RequireAuth, RequireOwner } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { MenuPage } from './pages/MenuPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OwnerPage } from './pages/OwnerPage';
import { PaymentPage } from './pages/PaymentPage';
import { ReservationsPage } from './pages/ReservationsPage';
import { RestaurantFormPage } from './pages/RestaurantFormPage';
import { RestaurantPage } from './pages/RestaurantPage';
import { RestaurantsPage } from './pages/RestaurantsPage';

function NotFound() {
  return (
    <div className="grid justify-items-start gap-3">
      <h1 className="text-3xl font-bold">No encontramos esa página</h1>
      <Link to="/" className="font-semibold text-sifon-dark underline">
        Volver a los restaurantes
      </Link>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<RestaurantsPage />} />
        <Route path="restaurantes/:id" element={<RestaurantPage />} />
        <Route path="ingresar" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route path="notificaciones" element={<NotificationsPage />} />
          <Route path="reservas" element={<ReservationsPage />} />
          <Route path="reservas/:id/pagar" element={<PaymentPage />} />
          <Route element={<RequireOwner />}>
            <Route path="panel" element={<OwnerPage />} />
            <Route path="panel/restaurantes/nuevo" element={<RestaurantFormPage />} />
            <Route path="panel/restaurantes/:id" element={<RestaurantFormPage />} />
            <Route path="panel/restaurantes/:id/carta" element={<MenuPage />} />
          </Route>
        </Route>
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

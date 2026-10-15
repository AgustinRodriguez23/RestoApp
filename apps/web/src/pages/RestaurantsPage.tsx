import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useRestaurants } from '../api/hooks';
import { Button, EmptyState, ErrorNotice, Field, inputClass, Spinner } from '../components/ui';

/** Espera a que el usuario deje de tipear para buscar: una consulta por pausa, no una por letra. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function RestaurantsPage() {
  // Búsqueda y página viven en la URL: se pueden compartir, recargar y volver con el botón "atrás"
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const cuisine = params.get('cocina') ?? '';
  const page = Math.max(1, Number(params.get('pagina')) || 1);

  const [searchText, setSearchText] = useState(search);
  const [cuisineText, setCuisineText] = useState(cuisine);
  const debouncedSearch = useDebounced(searchText.trim(), 350);
  const debouncedCuisine = useDebounced(cuisineText.trim(), 350);

  useEffect(() => {
    if (debouncedSearch === search && debouncedCuisine === cuisine) return;
    const next = new URLSearchParams();
    if (debouncedSearch) next.set('q', debouncedSearch);
    if (debouncedCuisine) next.set('cocina', debouncedCuisine);
    setParams(next, { replace: true }); // al filtrar se vuelve a la página 1
  }, [debouncedSearch, debouncedCuisine, search, cuisine, setParams]);

  const { data, error, isPending, isFetching, refetch } = useRestaurants({ search, cuisine, page });

  function goTo(nextPage: number) {
    const next = new URLSearchParams(params);
    next.set('pagina', String(nextPage));
    setParams(next);
    window.scrollTo({ top: 0 });
  }

  return (
    <div className="grid gap-8">
      <section className="grid gap-4">
        <h1 className="max-w-xl text-4xl font-bold leading-tight sm:text-5xl">Elegí dónde comer y reservá tu mesa</h1>
        <p className="max-w-xl text-muted">Para cuidar la mesa se pide una seña, que se devuelve si cancelás con tiempo.</p>
        <form role="search" className="grid gap-3 sm:grid-cols-[1fr_14rem]" onSubmit={(e) => e.preventDefault()}>
          <Field label="Buscar por nombre">
            <input className={inputClass} type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Por ejemplo, La Esquina" />
          </Field>
          <Field label="Tipo de cocina">
            <input className={inputClass} value={cuisineText} onChange={(e) => setCuisineText(e.target.value)} placeholder="Por ejemplo, Parrilla" />
          </Field>
        </form>
      </section>

      <section aria-live="polite" aria-busy={isFetching} className="grid gap-5">
        {isPending && (
          <div className="flex items-center gap-3 text-muted">
            <Spinner /> Buscando restaurantes…
          </div>
        )}
        {error && !data && <ErrorNotice error={error} onRetry={() => void refetch()} title="No pudimos cargar los restaurantes" />}
        {data && data.data.length === 0 && (
          <EmptyState title="No encontramos restaurantes con esa búsqueda">
            <p className="text-muted">Probá con otro nombre o borrá el filtro de cocina.</p>
            <Button
              variant="secondary"
              onClick={() => {
                setSearchText('');
                setCuisineText('');
              }}
            >
              Borrar filtros
            </Button>
          </EmptyState>
        )}
        {data && data.data.length > 0 && (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.data.map((restaurant) => (
              <li key={restaurant.id}>
                <Link
                  to={`/restaurantes/${restaurant.id}`}
                  className="group grid h-full content-between gap-6 rounded-xl border border-line bg-surface p-5 transition-colors hover:border-sifon"
                >
                  <div className="grid gap-1">
                    <h2 className="text-xl font-semibold leading-snug group-hover:text-sifon-dark">{restaurant.name}</h2>
                    <p className="text-sm font-medium text-sifon-dark">{restaurant.cuisine}</p>
                    {restaurant.description && <p className="mt-2 line-clamp-2 text-sm text-muted">{restaurant.description}</p>}
                  </div>
                  <p className="text-sm text-muted">{restaurant.address}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {data && data.totalPages > 1 && (
          <nav aria-label="Páginas" className="flex items-center justify-between gap-3">
            <Button variant="secondary" disabled={page <= 1} onClick={() => goTo(page - 1)}>
              Anterior
            </Button>
            <span className="text-sm text-muted">
              Página {data.page} de {data.totalPages}
            </span>
            <Button variant="secondary" disabled={page >= data.totalPages} onClick={() => goTo(page + 1)}>
              Siguiente
            </Button>
          </nav>
        )}
      </section>
    </div>
  );
}

import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDeleteMenuItem, useMyRestaurants, useOwnerMenu, useSaveMenuItem, useSetMenuItemAvailable } from '../api/hooks';
import type { MenuItem } from '../api/types';
import { Button, EmptyState, ErrorNotice, Field, inputClass, Spinner } from '../components/ui';
import { ALLERGEN_CODES, allergenLabel, formatMoney } from '../lib/format';
import { emptyMenuForm, formFromItem, toMenuInput, validateMenu, type MenuFormErrors, type MenuFormState } from '../lib/menuForm';
import { useAppDispatch } from '../store';
import { toastActions } from '../store/toastSlice';

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="text-sm font-medium text-danger">
      {message}
    </p>
  ) : null;
}

interface FormProps {
  restaurantId: string;
  item?: MenuItem;
  categories: string[];
  onDone: () => void;
}

function ItemForm({ restaurantId, item, categories, onDone }: FormProps) {
  const dispatch = useAppDispatch();
  const save = useSaveMenuItem(restaurantId);
  const [form, setForm] = useState<MenuFormState>(() => (item ? formFromItem(item) : emptyMenuForm()));
  const [errors, setErrors] = useState<MenuFormErrors>({});

  const set = <K extends keyof MenuFormState>(key: K, value: MenuFormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggleAllergen = (code: string) =>
    set('allergens', form.allergens.includes(code) ? form.allergens.filter((a) => a !== code) : [...form.allergens, code]);
  const setVariant = (i: number, patch: Partial<MenuFormState['variants'][number]>) =>
    set('variants', form.variants.map((v, index) => (index === i ? { ...v, ...patch } : v)));

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = validateMenu(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    save.mutate(
      { itemId: item?.id, input: toMenuInput(form) },
      {
        onSuccess: () => {
          dispatch(toastActions.push('success', item ? 'Plato actualizado' : 'Plato agregado'));
          onDone();
        },
      },
    );
  }

  return (
    <form onSubmit={submit} noValidate aria-label={item ? 'Editar plato' : 'Nuevo plato'} className="grid gap-5 rounded-xl border border-sifon/40 bg-surface p-5">
      <h2 className="font-display text-xl font-semibold">{item ? `Editar ${item.name}` : 'Nuevo plato'}</h2>

      <div className="grid items-start gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Field label="Categoría" hint="Por ejemplo: Entradas, Principales, Postres">
            <input className={inputClass} list="menu-categories" value={form.category} onChange={(e) => set('category', e.target.value)} maxLength={60} />
          </Field>
          <datalist id="menu-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <FieldError message={errors.category} />
        </div>
        <div className="grid gap-1.5">
          <Field label="Nombre del plato">
            <input className={inputClass} value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={100} />
          </Field>
          <FieldError message={errors.name} />
        </div>
        <div className="grid gap-1.5">
          <Field label="Precio ($)" hint="En pesos; se pueden usar centavos: 12500,50">
            <input className={inputClass} inputMode="decimal" value={form.price} onChange={(e) => set('price', e.target.value)} />
          </Field>
          <FieldError message={errors.price} />
        </div>
        <div className="grid gap-1.5">
          <Field label="Descripción (opcional)">
            <input className={inputClass} value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={500} />
          </Field>
          <FieldError message={errors.description} />
        </div>
      </div>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Alérgenos que contiene</legend>
        <div className="flex flex-wrap gap-2">
          {ALLERGEN_CODES.map((code) => (
            <label
              key={code}
              className={`inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm ${
                form.allergens.includes(code) ? 'border-ink bg-ink text-white' : 'border-line bg-surface hover:border-sifon'
              }`}
            >
              <input type="checkbox" className="sr-only" checked={form.allergens.includes(code)} onChange={() => toggleAllergen(code)} />
              {allergenLabel(code)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">Variantes (opcional)</legend>
        <p className="text-sm text-muted">Por ejemplo «Porción grande» con +1500, o «Sin sal» con 0. La diferencia puede ser negativa.</p>
        {form.variants.map((variant, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3">
            <Field label={`Nombre de la variante ${i + 1}`}>
              <input className={`${inputClass} w-56`} value={variant.name} onChange={(e) => setVariant(i, { name: e.target.value })} maxLength={60} />
            </Field>
            <Field label={`Diferencia de precio ${i + 1} ($)`}>
              <input className={`${inputClass} w-36`} inputMode="decimal" value={variant.delta} onChange={(e) => setVariant(i, { delta: e.target.value })} />
            </Field>
            <Button type="button" variant="ghost" aria-label={`Quitar la variante ${i + 1}`} onClick={() => set('variants', form.variants.filter((_, index) => index !== i))}>
              Quitar
            </Button>
          </div>
        ))}
        <FieldError message={errors.variants} />
        <div>
          <Button type="button" variant="secondary" disabled={form.variants.length >= 20} onClick={() => set('variants', [...form.variants, { name: '', delta: '0' }])}>
            Agregar variante
          </Button>
        </div>
      </fieldset>

      <label className="inline-flex items-center gap-3 text-sm font-medium">
        <input type="checkbox" className="size-5" checked={form.available} onChange={(e) => set('available', e.target.checked)} />
        Disponible (se muestra en la carta pública)
      </label>

      {save.error && <ErrorNotice error={save.error} title="No pudimos guardar el plato" />}
      <div className="flex gap-3">
        <Button type="submit" busy={save.isPending}>
          {item ? 'Guardar cambios' : 'Agregar plato'}
        </Button>
        <Button type="button" variant="secondary" disabled={save.isPending} onClick={onDone}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function ItemRow({ restaurantId, item, onEdit }: { restaurantId: string; item: MenuItem; onEdit: () => void }) {
  const dispatch = useAppDispatch();
  const toggle = useSetMenuItemAvailable(restaurantId);
  const remove = useDeleteMenuItem(restaurantId);
  const [confirming, setConfirming] = useState(false);
  const error = toggle.error ?? remove.error;

  return (
    <li className={`grid gap-3 rounded-xl border border-line p-4 sm:grid-cols-[1fr_auto] ${item.available ? 'bg-surface' : 'bg-line/40'}`}>
      <div className="grid gap-1">
        <p className="font-semibold">
          {item.name} · {formatMoney(item.priceCents)}
          {!item.available && <span className="ml-2 rounded-full bg-amber px-2.5 py-1 text-xs font-semibold text-amber-ink">Pausado</span>}
        </p>
        {item.description && <p className="text-sm text-muted">{item.description}</p>}
        {item.allergens.length > 0 && <p className="text-xs text-muted">Contiene: {item.allergens.map(allergenLabel).join(', ')}</p>}
        {item.variants.length > 0 && (
          <p className="text-xs text-muted">
            Variantes: {item.variants.map((v) => `${v.name} (${v.priceDeltaCents >= 0 ? '+' : '−'}${formatMoney(Math.abs(v.priceDeltaCents))})`).join(', ')}
          </p>
        )}
      </div>
      <div className="grid content-start gap-2">
        {error && <ErrorNotice error={error} title="No pudimos actualizar el plato" />}
        {confirming ? (
          <div className="grid gap-2">
            <p className="text-sm font-medium">¿Quitar «{item.name}» de la carta?</p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                busy={remove.isPending}
                onClick={() => remove.mutate(item.id ?? '', { onSuccess: () => dispatch(toastActions.push('success', 'Plato quitado')) })}
              >
                Sí, quitar
              </Button>
              <Button variant="secondary" disabled={remove.isPending} onClick={() => setConfirming(false)}>
                No
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={onEdit} aria-label={`Editar ${item.name}`}>
              Editar
            </Button>
            <Button
              variant="secondary"
              busy={toggle.isPending}
              aria-label={`${item.available ? 'Pausar' : 'Activar'} ${item.name}`}
              onClick={() => toggle.mutate({ itemId: item.id ?? '', available: !item.available })}
            >
              {item.available ? 'Pausar' : 'Activar'}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(true)} aria-label={`Quitar ${item.name}`}>
              Quitar
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

/** /panel/restaurantes/:id/carta */
export function MenuPage() {
  const { id = '' } = useParams();
  const mine = useMyRestaurants();
  const menu = useOwnerMenu(id);
  const [editing, setEditing] = useState<MenuItem | 'new' | null>(null);
  const restaurant = mine.data?.find((r) => r.id === id);
  const categories = menu.data?.map((c) => c.category) ?? [];
  const isEmpty = menu.data !== undefined && menu.data.length === 0;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Carta</h1>
          {restaurant && <p className="text-muted">{restaurant.name}</p>}
        </div>
        {editing === null && (
          <Button onClick={() => setEditing('new')} disabled={!menu.data}>
            Agregar plato
          </Button>
        )}
      </div>
      <Link to="/panel" className="-mt-3 font-semibold text-sifon-dark underline">
        Volver al panel
      </Link>

      {mine.data && !restaurant && <p>No encontramos ese restaurante entre los tuyos.</p>}
      {menu.isPending && (
        <div className="flex items-center gap-3 text-muted">
          <Spinner /> Cargando la carta…
        </div>
      )}
      {menu.error && !menu.data && <ErrorNotice error={menu.error} onRetry={() => void menu.refetch()} title="No pudimos cargar la carta" />}

      {editing !== null && (
        <ItemForm
          key={editing === 'new' ? 'nuevo' : editing.id}
          restaurantId={id}
          item={editing === 'new' ? undefined : editing}
          categories={categories}
          onDone={() => setEditing(null)}
        />
      )}

      {isEmpty && editing === null && (
        <EmptyState title="La carta todavía está vacía">
          <p className="text-sm text-muted">Agregá el primer plato: los clientes lo van a ver en la página del restaurante.</p>
        </EmptyState>
      )}

      {menu.data?.map((group) => (
        <section key={group.category} aria-label={group.category} className="grid gap-3">
          <h2 className="font-display text-xl font-semibold">{group.category}</h2>
          <ul className="grid gap-3">
            {group.items.map((item) => (
              <ItemRow key={item.id} restaurantId={id} item={item} onEdit={() => setEditing(item)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

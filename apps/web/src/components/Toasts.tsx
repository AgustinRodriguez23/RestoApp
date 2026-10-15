import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { toastActions, type Toast } from '../store/toastSlice';

const TONE: Record<Toast['kind'], string> = {
  success: 'border-ok bg-ok-soft text-ok',
  error: 'border-danger bg-danger-soft text-danger',
  info: 'border-sifon bg-sifon-soft text-sifon-dark',
};

function ToastItem({ toast }: { toast: Toast }) {
  const dispatch = useAppDispatch();
  useEffect(() => {
    const timer = setTimeout(() => dispatch(toastActions.dismiss(toast.id)), 6000);
    return () => clearTimeout(timer);
  }, [dispatch, toast.id]);

  return (
    <li className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm font-medium shadow-sm ${TONE[toast.kind]}`}>
      <span className="flex-1">{toast.text}</span>
      <button type="button" aria-label="Cerrar aviso" className="-m-1 p-1 leading-none" onClick={() => dispatch(toastActions.dismiss(toast.id))}>
        ✕
      </button>
    </li>
  );
}

export function Toasts() {
  const toasts = useAppSelector((state) => state.toasts);
  return (
    <ul aria-live="polite" className="fixed inset-x-4 bottom-4 z-50 mx-auto grid max-w-md gap-2">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </ul>
  );
}

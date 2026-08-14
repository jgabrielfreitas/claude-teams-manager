import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { CatalogDto, SettingsDto } from '@claude-team/protocol';
import { client } from '../api';
import { useResource } from '../hooks/use-resource';
import { Loading } from '../components/ui';

/**
 * Catalogs (models, efforts, tool groups, templates, presets) and the current
 * settings, loaded once and refreshed from the event stream. Every picker in
 * the app reads from here rather than hard-coding a list.
 */

interface CatalogValue {
  catalog: CatalogDto;
  settings: SettingsDto;
  reload: () => void;
  modelLabel: (id: string) => string;
}

const CatalogContext = createContext<CatalogValue | undefined>(undefined);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const catalog = useResource(
    () => client.getCatalog(),
    [],
    (event) => event.type === 'agent.changed',
  );
  const settings = useResource(
    () => client.getSettings(),
    [],
    (event) => event.type === 'settings.changed',
  );

  const theme = settings.data?.theme ?? 'auto';
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const resolved = theme === 'auto' ? (media.matches ? 'light' : 'dark') : theme;
      root.setAttribute('data-theme', resolved);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  const catalogData = catalog.data;
  const settingsData = settings.data;
  const reloadCatalog = catalog.reload;
  const reloadSettings = settings.reload;

  const value = useMemo<CatalogValue | undefined>(() => {
    if (!catalogData || !settingsData) return undefined;
    const models = catalogData.models;
    return {
      catalog: catalogData,
      settings: settingsData,
      reload: () => {
        reloadCatalog();
        reloadSettings();
      },
      modelLabel: (id: string) => models.find((m) => m.id === id)?.label ?? id,
    };
  }, [catalogData, settingsData, reloadCatalog, reloadSettings]);

  if (!value) {
    if (catalog.error || settings.error) {
      return (
        <div className="wizard">
          <div className="wizard-card">
            <div className="wizard-body">
              <h1>Cannot reach the server</h1>
              <p className="muted">
                {(catalog.error ?? settings.error)?.message ?? 'The API did not respond.'}
              </p>
              <div>
                <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
                  Retry
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return <Loading label="Starting Claude Team…" />;
  }

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogValue {
  const value = useContext(CatalogContext);
  if (!value) throw new Error('useCatalog must be used inside <CatalogProvider>');
  return value;
}

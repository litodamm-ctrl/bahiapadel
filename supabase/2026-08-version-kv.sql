-- Bahía Padel · control de versiones en la tabla kv
-- Evita que dos recepcionistas se pisen una reserva: cada escritura de un día
-- lleva la versión que leyó y la base de datos sube la versión sola.
-- Ejecutar UNA vez en Supabase → SQL Editor → New query → Run.

alter table public.kv add column if not exists version integer not null default 0;

create or replace function public.kv_sube_version()
returns trigger language plpgsql as $$
begin
  new.version := coalesce(old.version, 0) + 1;
  return new;
end $$;

drop trigger if exists kv_sube_version on public.kv;
create trigger kv_sube_version
  before update on public.kv
  for each row execute function public.kv_sube_version();

-- Seguridad: solo las funciones de Netlify (service role) pueden leer o escribir.
alter table public.kv enable row level security;
alter table public.premios_entregados enable row level security;
alter table public.campanas_reactivacion enable row level security;

-- Comprobación: debe devolver la columna "version"
select column_name from information_schema.columns where table_name = 'kv' and column_name = 'version';

alter table public.projects
  add column if not exists map_json jsonb not null
  default '{"version":1,"nodes":[],"edges":[]}'::jsonb;

comment on column public.projects.map_json is
  'Canonical project-level orchestration map. Nodes are workload/thinking units that own one or more sessions; edges pass selected node outputs downstream.';

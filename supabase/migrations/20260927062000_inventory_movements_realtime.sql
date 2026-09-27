do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname='supabase_realtime'
      and schemaname='public'
      and tablename='inventory_movements'
  ) then
    alter publication supabase_realtime add table public.inventory_movements;
  end if;
end
$$;
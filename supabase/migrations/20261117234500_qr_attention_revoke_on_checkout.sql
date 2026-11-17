create or replace function public.revoke_qr_attention_on_order_close()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (new.status in ('closed','cancelled','merged') or new.payment_status='paid')
 and (old.status is distinct from new.status or old.payment_status is distinct from new.payment_status) then
   update public.qr_attention_sessions s set revoked_at=now()
   where s.revoked_at is null and s.restaurant_id=new.restaurant_id and s.location_id=new.location_id
   and exists(select 1 from public.order_table_links l
     where l.order_id=new.id and l.table_id=s.table_id and l.unlinked_at is null);
 end if;
 return new;
end $$;
revoke all on function public.revoke_qr_attention_on_order_close() from public,anon,authenticated;
drop trigger if exists revoke_qr_attention_on_order_close on public.orders;
create trigger revoke_qr_attention_on_order_close after update of status,payment_status on public.orders
for each row execute function public.revoke_qr_attention_on_order_close();
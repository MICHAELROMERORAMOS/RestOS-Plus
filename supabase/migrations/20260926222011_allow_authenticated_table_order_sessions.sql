grant execute on function private.load_table_order_sessions(uuid, uuid) to authenticated;
grant execute on function private.claim_table_order_session(uuid, uuid, uuid) to authenticated;
grant execute on function private.touch_table_order_session(uuid) to authenticated;
grant execute on function private.release_table_order_session(uuid) to authenticated;

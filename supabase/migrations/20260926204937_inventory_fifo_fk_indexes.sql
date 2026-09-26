create index if not exists inventory_fifo_layers_restaurant_idx on private.inventory_fifo_layers(restaurant_id);
create index if not exists inventory_fifo_layers_item_idx on private.inventory_fifo_layers(inventory_item_id);
create index if not exists inventory_fifo_allocations_restaurant_idx on private.inventory_fifo_allocations(restaurant_id);
create index if not exists inventory_fifo_allocations_location_idx on private.inventory_fifo_allocations(location_id);
create index if not exists inventory_fifo_allocations_item_idx on private.inventory_fifo_allocations(inventory_item_id);
create index if not exists inventory_fifo_allocations_layer_idx on private.inventory_fifo_allocations(fifo_layer_id);
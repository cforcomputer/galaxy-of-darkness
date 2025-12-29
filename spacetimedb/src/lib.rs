use spacetimedb::{Identity, ReducerContext};

const DEFAULT_CARGO_CAPACITY_M3: u32 = 160;

// Placeholder loot
const ITEM_SALVAGED_SCRAP: u16 = 1;
const ITEM_SALVAGED_SCRAP_VOLUME_M3: u32 = 10;

#[spacetimedb::table(name = player, public)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    pub cargo_capacity_m3: u32,
}

#[spacetimedb::table(name = player_item, public)]
pub struct PlayerItem {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[index(btree)]
    pub owner: Identity,

    pub item_type: u16,
    pub quantity: u32,
    pub volume_m3: u32,
}

#[spacetimedb::table(name = wreck, public)]
pub struct Wreck {
    #[primary_key]
    pub id: u64,

    #[index(btree)]
    pub site_id: u64,

    pub pos_x_m: f64,
    pub pos_y_m: f64,
    pub pos_z_m: f64,
}

#[spacetimedb::table(name = wreck_item, public)]
pub struct WreckItem {
    #[primary_key]
    #[auto_inc]
    pub id: u64,

    #[index(btree)]
    pub wreck_id: u64,

    pub item_type: u16,
    pub quantity: u32,
    pub volume_m3: u32,
}

#[spacetimedb::reducer(init)]
pub fn init(_ctx: &ReducerContext) {}

#[spacetimedb::reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) {
    // Ensure a Player row exists (persists between sessions for the same Identity)
    if ctx.db.player().identity().find(ctx.sender).is_none() {
        ctx.db.player().insert(Player {
            identity: ctx.sender,
            cargo_capacity_m3: DEFAULT_CARGO_CAPACITY_M3,
        });
    }
}

/// Client can request spawning a wreck (placeholder until NPCs are authoritative server-side).
#[spacetimedb::reducer]
pub fn spawn_wreck(ctx: &ReducerContext, wreck_id: u64, site_id: u64, pos_x_m: f64, pos_y_m: f64, pos_z_m: f64) {
    if ctx.db.wreck().id().find(wreck_id).is_some() {
        return;
    }

    ctx.db.wreck().insert(Wreck {
        id: wreck_id,
        site_id,
        pos_x_m,
        pos_y_m,
        pos_z_m,
    });

    // One placeholder item
    ctx.db.wreck_item().insert(WreckItem {
        id: 0, // auto_inc
        wreck_id,
        item_type: ITEM_SALVAGED_SCRAP,
        quantity: 1,
        volume_m3: ITEM_SALVAGED_SCRAP_VOLUME_M3,
    });
}

fn cargo_used_m3(ctx: &ReducerContext, owner: Identity) -> u32 {
    ctx.db
        .player_item()
        .iter()
        .filter(|r| r.owner == owner)
        .fold(0u32, |acc, r| acc.saturating_add(r.quantity.saturating_mul(r.volume_m3)))
}

fn add_to_inventory(ctx: &ReducerContext, owner: Identity, item_type: u16, volume_m3: u32, quantity: u32) {
    if quantity == 0 {
        return;
    }

    // Merge into an existing stack if present.
    if let Some(existing) = ctx
        .db
        .player_item()
        .iter()
        .find(|r| r.owner == owner && r.item_type == item_type && r.volume_m3 == volume_m3)
    {
        let mut updated = existing.clone();
        updated.quantity = updated.quantity.saturating_add(quantity);
        ctx.db.player_item().id().update(updated);
        return;
    }

    ctx.db.player_item().insert(PlayerItem {
        id: 0, // auto_inc
        owner,
        item_type,
        quantity,
        volume_m3,
    });
}

/// Loot as much as fits; if everything is looted, the wreck is removed.
#[spacetimedb::reducer]
pub fn loot_all(ctx: &ReducerContext, wreck_id: u64) -> Result<(), String> {
    let wreck = ctx
        .db
        .wreck()
        .id()
        .find(wreck_id)
        .ok_or_else(|| "Wreck not found".to_string())?;

    let player = ctx
        .db
        .player()
        .identity()
        .find(ctx.sender)
        .ok_or_else(|| "Player not found".to_string())?;

    let mut free_m3 = player
        .cargo_capacity_m3
        .saturating_sub(cargo_used_m3(ctx, ctx.sender));

    // Collect wreck items first (so we can mutate/delete safely)
    let mut items: Vec<WreckItem> = ctx
        .db
        .wreck_item()
        .iter()
        .filter(|r| r.wreck_id == wreck_id)
        .collect();

    items.sort_by_key(|r| r.id);

    for wi in items {
        if free_m3 == 0 {
            break;
        }

        let per_unit = wi.volume_m3.max(1);
        let max_take = free_m3 / per_unit;
        if max_take == 0 {
            continue;
        }

        let take_qty = wi.quantity.min(max_take);
        add_to_inventory(ctx, ctx.sender, wi.item_type, wi.volume_m3, take_qty);

        free_m3 = free_m3.saturating_sub(take_qty.saturating_mul(per_unit));

        if take_qty == wi.quantity {
            ctx.db.wreck_item().id().delete(wi.id);
        } else {
            let mut updated = wi.clone();
            updated.quantity -= take_qty;
            ctx.db.wreck_item().id().update(updated);
        }
    }

    // If no items remain, delete wreck
    let any_left = ctx
        .db
        .wreck_item()
        .iter()
        .any(|r| r.wreck_id == wreck_id);

    if !any_left {
        ctx.db.wreck().id().delete(wreck.id);
    }

    Ok(())
}

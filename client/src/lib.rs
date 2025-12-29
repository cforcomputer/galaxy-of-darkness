use spacetimedb::{table, reducer, Identity, ReducerContext, Table, Timestamp};

#[table(name = user, public)]
pub struct User {
    #[primary_key]
    pub identity: Identity,
    pub name: Option<String>,
    pub online: bool,
}

#[table(name = ship, public)]
pub struct Ship {
    #[primary_key]
    pub owner: Identity,

    // World-space position/velocity (scaled units; client decides scaling).
    pub px: f64,
    pub py: f64,
    pub pz: f64,

    pub vx: f64,
    pub vy: f64,
    pub vz: f64,

    pub updated_at: Timestamp,
}

fn validate_name(name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        Err("Name must not be empty".to_string())
    } else if name.len() > 32 {
        Err("Name too long (max 32 chars)".to_string())
    } else {
        Ok(name)
    }
}

fn finite(v: f64) -> Result<f64, String> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err("Non-finite number rejected".to_string())
    }
}

#[reducer]
/// Set the player's display name (stored server-side).
pub fn set_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let name = validate_name(name)?;
    if let Some(user) = ctx.db.user().identity().find(ctx.sender) {
        ctx.db
            .user()
            .identity()
            .update(User { name: Some(name), ..user });
        Ok(())
    } else {
        Err("Cannot set name for unknown user".to_string())
    }
}

#[reducer]
/// Update ship state (client-authoritative for this MVP).
pub fn set_ship_state(
    ctx: &ReducerContext,
    px: f64,
    py: f64,
    pz: f64,
    vx: f64,
    vy: f64,
    vz: f64,
) -> Result<(), String> {
    let px = finite(px)?;
    let py = finite(py)?;
    let pz = finite(pz)?;
    let vx = finite(vx)?;
    let vy = finite(vy)?;
    let vz = finite(vz)?;

    if let Some(ship) = ctx.db.ship().owner().find(ctx.sender) {
        ctx.db.ship().owner().update(Ship {
            owner: ship.owner,
            px,
            py,
            pz,
            vx,
            vy,
            vz,
            updated_at: ctx.timestamp,
        });
        Ok(())
    } else {
        Err("No ship found for user".to_string())
    }
}

#[reducer]
/// Warp ship to a position (instant for MVP).
pub fn warp_to(ctx: &ReducerContext, px: f64, py: f64, pz: f64) -> Result<(), String> {
    let px = finite(px)?;
    let py = finite(py)?;
    let pz = finite(pz)?;

    if let Some(ship) = ctx.db.ship().owner().find(ctx.sender) {
        ctx.db.ship().owner().update(Ship {
            owner: ship.owner,
            px,
            py,
            pz,
            vx: 0.0,
            vy: 0.0,
            vz: 0.0,
            updated_at: ctx.timestamp,
        });
        Ok(())
    } else {
        Err("No ship found for user".to_string())
    }
}

#[reducer(client_connected)]
/// Called automatically when a client connects.
/// This special reducer pattern is documented in the Rust quickstart. :contentReference[oaicite:9]{index=9}
pub fn client_connected(ctx: &ReducerContext) {
    // Upsert user
    if let Some(user) = ctx.db.user().identity().find(ctx.sender) {
        ctx.db
            .user()
            .identity()
            .update(User { online: true, ..user });
    } else {
        ctx.db.user().insert(User {
            identity: ctx.sender,
            name: None,
            online: true,
        });
    }

    // Upsert ship (spawn near origin)
    if ctx.db.ship().owner().find(ctx.sender).is_none() {
        ctx.db.ship().insert(Ship {
            owner: ctx.sender,
            px: 0.01,
            py: 0.0,
            pz: 0.0,
            vx: 0.0,
            vy: 0.0,
            vz: 0.0,
            updated_at: ctx.timestamp,
        });
    }
}

#[reducer(client_disconnected)]
/// Called automatically when a client disconnects. :contentReference[oaicite:10]{index=10}
pub fn client_disconnected(ctx: &ReducerContext) {
    if let Some(user) = ctx.db.user().identity().find(ctx.sender) {
        ctx.db
            .user()
            .identity()
            .update(User { online: false, ..user });
    }
}

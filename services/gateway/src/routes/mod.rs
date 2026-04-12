pub mod agents;
pub mod health;
pub mod runs;

use axum::Router;

use crate::state::AppState;

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .merge(health::routes())
        .merge(agents::routes(state.clone()))
        .merge(runs::routes(state))
}

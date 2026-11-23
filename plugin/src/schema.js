export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    asset_key TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    revision INTEGER NOT NULL DEFAULT 1,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    validated_at TEXT,
    reviewed_at TEXT,
    reviewed_by TEXT,
    published_at TEXT,
    UNIQUE (project_id, kind, asset_key, revision)
);

CREATE TABLE IF NOT EXISTS content_versions (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    data_json TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_reviews (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES content_assets(id) ON DELETE CASCADE,
    validation_json TEXT NOT NULL DEFAULT '{}',
    reviewer TEXT NOT NULL DEFAULT '',
    decision TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    package_json TEXT NOT NULL,
    package_hash TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    published_at TEXT,
    UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS worlds (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES game_projects(id) ON DELETE CASCADE,
    game_version_id TEXT NOT NULL REFERENCES game_versions(id) ON DELETE CASCADE,
    world_key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    start_location_id TEXT,
    data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    location_key TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'town',
    description TEXT NOT NULL DEFAULT '',
    parent_id TEXT,
    map_x REAL NOT NULL DEFAULT 0,
    map_y REAL NOT NULL DEFAULT 0,
    region TEXT NOT NULL DEFAULT '',
    image TEXT,
    discovered_by_default INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL,
    UNIQUE (world_id, location_key)
);

CREATE TABLE IF NOT EXISTS location_connections (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    from_location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    to_location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    travel_cost INTEGER NOT NULL DEFAULT 0,
    condition_json TEXT NOT NULL DEFAULT '{}',
    bidirectional INTEGER NOT NULL DEFAULT 1,
    data_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (world_id, from_location_id, to_location_id)
);

CREATE TABLE IF NOT EXISTS encounter_spawns (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    encounter_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    respawn_at TEXT,
    defeated_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (campaign_id, location_id, encounter_key)
);
CREATE TABLE IF NOT EXISTS location_discoveries (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    discovered_at TEXT NOT NULL,
    PRIMARY KEY (campaign_id, location_id)
);

CREATE TABLE IF NOT EXISTS entity_templates (
    id TEXT PRIMARY KEY,
    game_version_id TEXT NOT NULL REFERENCES game_versions(id) ON DELETE CASCADE,
    template_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    data_json TEXT NOT NULL,
    UNIQUE (game_version_id, kind, template_key)
);

CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id),
    game_version_id TEXT NOT NULL REFERENCES game_versions(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    player_entity_id TEXT,
    current_location_id TEXT REFERENCES locations(id),
    game_state_json TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_played_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_bindings (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    chat_key TEXT NOT NULL,
    character_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE (chat_key)
);

CREATE TABLE IF NOT EXISTS entity_stats (
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    stat_key TEXT NOT NULL,
    base_value REAL NOT NULL DEFAULT 0,
    permanent_bonus REAL NOT NULL DEFAULT 0,
    temporary_bonus REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (entity_id, stat_key)
);

CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    template_id TEXT REFERENCES entity_templates(id),
    entity_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    xp INTEGER NOT NULL DEFAULT 0,
    hp REAL NOT NULL DEFAULT 1,
    mp REAL NOT NULL DEFAULT 0,
    gold INTEGER NOT NULL DEFAULT 0,
    location_id TEXT REFERENCES locations(id),
    faction TEXT NOT NULL DEFAULT 'neutral',
    alive INTEGER NOT NULL DEFAULT 1,
    is_player INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (campaign_id, entity_key)
);

CREATE TABLE IF NOT EXISTS item_definitions (
    id TEXT PRIMARY KEY,
    game_version_id TEXT NOT NULL REFERENCES game_versions(id) ON DELETE CASCADE,
    item_key TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    rarity TEXT NOT NULL DEFAULT 'common',
    description TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL DEFAULT 0,
    stackable INTEGER NOT NULL DEFAULT 1,
    max_stack INTEGER NOT NULL DEFAULT 99,
    slot TEXT,
    data_json TEXT NOT NULL,
    UNIQUE (game_version_id, item_key)
);

CREATE TABLE IF NOT EXISTS inventory (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    item_definition_id TEXT NOT NULL REFERENCES item_definitions(id),
    item_key TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    instance_key TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (entity_id, item_definition_id, instance_key)
);

CREATE TABLE IF NOT EXISTS equipment_slots (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    slot TEXT NOT NULL,
    inventory_id TEXT NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
    UNIQUE (entity_id, slot),
    UNIQUE (inventory_id)
);

CREATE TABLE IF NOT EXISTS skill_definitions (
    id TEXT PRIMARY KEY,
    game_version_id TEXT NOT NULL REFERENCES game_versions(id) ON DELETE CASCADE,
    skill_key TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'active',
    mp_cost INTEGER NOT NULL DEFAULT 0,
    cooldown INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL,
    UNIQUE (game_version_id, skill_key)
);

CREATE TABLE IF NOT EXISTS entity_skills (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    skill_definition_id TEXT NOT NULL REFERENCES skill_definitions(id),
    skill_key TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    unlocked_at TEXT NOT NULL,
    UNIQUE (entity_id, skill_definition_id)
);

CREATE TABLE IF NOT EXISTS status_effect_definitions (
    id TEXT PRIMARY KEY,
    game_version_id TEXT NOT NULL REFERENCES game_versions(id) ON DELETE CASCADE,
    effect_key TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'debuff',
    data_json TEXT NOT NULL,
    UNIQUE (game_version_id, effect_key)
);

CREATE TABLE IF NOT EXISTS status_effect_instances (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    effect_definition_id TEXT REFERENCES status_effect_definitions(id),
    effect_key TEXT NOT NULL,
    duration INTEGER NOT NULL DEFAULT 1,
    stacks INTEGER NOT NULL DEFAULT 1,
    data_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS event_definitions (
    id TEXT PRIMARY KEY,
    game_version_id TEXT NOT NULL REFERENCES game_versions(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    name TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'scene',
    scene_key TEXT,
    trigger TEXT NOT NULL DEFAULT 'enter',
    target_key TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    once INTEGER NOT NULL DEFAULT 1,
    condition_json TEXT NOT NULL DEFAULT '{}',
    actions_json TEXT NOT NULL DEFAULT '[]',
    data_json TEXT NOT NULL,
    UNIQUE (game_version_id, event_key)
);
CREATE TABLE IF NOT EXISTS story_nodes (
    id TEXT PRIMARY KEY,
    game_version_id TEXT NOT NULL REFERENCES game_versions(id) ON DELETE CASCADE,
    node_key TEXT NOT NULL,
    story_key TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'scene',
    text TEXT NOT NULL DEFAULT '',
    data_json TEXT NOT NULL,
    UNIQUE (game_version_id, node_key)
);

CREATE TABLE IF NOT EXISTS story_edges (
    id TEXT PRIMARY KEY,
    game_version_id TEXT NOT NULL REFERENCES game_versions(id) ON DELETE CASCADE,
    edge_key TEXT NOT NULL,
    story_key TEXT NOT NULL,
    from_node_key TEXT NOT NULL,
    to_node_key TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    condition_json TEXT NOT NULL DEFAULT '{}',
    actions_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE (game_version_id, edge_key)
);

CREATE TABLE IF NOT EXISTS quest_definitions (
    id TEXT PRIMARY KEY,
    game_version_id TEXT NOT NULL REFERENCES game_versions(id) ON DELETE CASCADE,
    quest_key TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'side',
    description TEXT NOT NULL DEFAULT '',
    data_json TEXT NOT NULL,
    UNIQUE (game_version_id, quest_key)
);

CREATE TABLE IF NOT EXISTS quest_nodes (
    id TEXT PRIMARY KEY,
    quest_definition_id TEXT NOT NULL REFERENCES quest_definitions(id) ON DELETE CASCADE,
    node_key TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'stage',
    data_json TEXT NOT NULL,
    UNIQUE (quest_definition_id, node_key)
);

CREATE TABLE IF NOT EXISTS quest_edges (
    id TEXT PRIMARY KEY,
    quest_definition_id TEXT NOT NULL REFERENCES quest_definitions(id) ON DELETE CASCADE,
    edge_key TEXT NOT NULL,
    from_node_key TEXT NOT NULL,
    to_node_key TEXT NOT NULL,
    condition_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (quest_definition_id, edge_key)
);

CREATE TABLE IF NOT EXISTS quest_instances (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    quest_definition_id TEXT NOT NULL REFERENCES quest_definitions(id),
    quest_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    stage_key TEXT,
    progress_json TEXT NOT NULL DEFAULT '{}',
    accepted_at TEXT,
    completed_at TEXT,
    turned_in_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (campaign_id, quest_key)
);

CREATE TABLE IF NOT EXISTS combat_sessions (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    encounter_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    location_id TEXT REFERENCES locations(id),
    round INTEGER NOT NULL DEFAULT 1,
    turn_order_json TEXT NOT NULL DEFAULT '[]',
    current_actor_id TEXT,
    rng_state INTEGER NOT NULL DEFAULT 1,
    result_json TEXT,
    started_at TEXT,
    ended_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS combat_participants (
    id TEXT PRIMARY KEY,
    combat_session_id TEXT NOT NULL REFERENCES combat_sessions(id) ON DELETE CASCADE,
    entity_id TEXT REFERENCES entities(id),
    name TEXT NOT NULL,
    side TEXT NOT NULL,
    initiative REAL NOT NULL DEFAULT 0,
    order_index INTEGER NOT NULL DEFAULT 0,
    hp REAL NOT NULL,
    max_hp REAL NOT NULL,
    mp REAL NOT NULL DEFAULT 0,
    max_mp REAL NOT NULL DEFAULT 0,
    stats_json TEXT NOT NULL DEFAULT '{}',
    resistances_json TEXT NOT NULL DEFAULT '{}',
    statuses_json TEXT NOT NULL DEFAULT '[]',
    alive INTEGER NOT NULL DEFAULT 1,
    is_player INTEGER NOT NULL DEFAULT 0,
    template_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS combat_actions (
    id TEXT PRIMARY KEY,
    combat_session_id TEXT NOT NULL REFERENCES combat_sessions(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    action_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (combat_session_id, sequence),
    UNIQUE (combat_session_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS game_events (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (campaign_id, seq),
    UNIQUE (campaign_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS save_snapshots (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    automatic INTEGER NOT NULL DEFAULT 0,
    snapshot_json TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_variables (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    var_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (campaign_id, var_key)
);

CREATE TABLE IF NOT EXISTS narrative_state (
    campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'tracker',
    state_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracker_sync_log (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    direction TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_imports (
    id TEXT PRIMARY KEY,
    campaign_id TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES game_projects(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_idempotency (
    key TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    status_code INTEGER NOT NULL DEFAULT 200,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_project ON content_assets(project_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_versions_project ON game_versions(project_id, status);
CREATE INDEX IF NOT EXISTS idx_locations_world ON locations(world_id);
CREATE INDEX IF NOT EXISTS idx_connections_world ON location_connections(world_id);
CREATE INDEX IF NOT EXISTS idx_entities_campaign ON entities(campaign_id, kind);
CREATE INDEX IF NOT EXISTS idx_inventory_entity ON inventory(entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_stack ON inventory(entity_id, item_definition_id, COALESCE(instance_key, ''));
CREATE INDEX IF NOT EXISTS idx_quests_campaign ON quest_instances(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_events_version ON event_definitions(game_version_id, scope, trigger);
CREATE INDEX IF NOT EXISTS idx_spawns_location ON encounter_spawns(campaign_id, location_id, status);
CREATE INDEX IF NOT EXISTS idx_combat_campaign ON combat_sessions(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON game_events(campaign_id, seq);
CREATE INDEX IF NOT EXISTS idx_saves_campaign ON save_snapshots(campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tracker_campaign ON tracker_sync_log(campaign_id, created_at);
`;

export const REQUIRED_TABLES = [
    'worlds', 'campaigns', 'chat_bindings', 'entities', 'entity_stats', 'entity_templates',
    'item_definitions', 'inventory', 'equipment_slots', 'skill_definitions', 'entity_skills',
    'status_effect_definitions', 'status_effect_instances', 'locations', 'location_connections',
    'location_discoveries', 'encounter_spawns', 'event_definitions', 'story_nodes', 'story_edges', 'quest_definitions', 'quest_nodes',
    'quest_edges', 'quest_instances', 'combat_sessions', 'combat_participants', 'combat_actions',
    'game_events', 'save_snapshots', 'game_projects', 'content_assets', 'content_versions',
    'content_reviews', 'tracker_sync_log',
];




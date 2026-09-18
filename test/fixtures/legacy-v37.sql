CREATE TABLE active_turns (
  task_id    TEXT NOT NULL,
  pointer    TEXT NOT NULL,
  turn_id    TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, pointer)
);

CREATE TABLE agent_profiles (
  id         TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE capability_grants (
  task_id    TEXT NOT NULL,
  grant_id   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, grant_id)
);

CREATE TABLE change_sets (
  task_id       TEXT NOT NULL,
  change_set_id TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (task_id, change_set_id)
);

CREATE TABLE config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE configured_agents (
  id         TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE context_snapshots (
  task_id     TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('task','workitem','stage')),
  scope_ref   TEXT,
  sequence    INTEGER NOT NULL CHECK (sequence > 0),
  digest      TEXT NOT NULL CHECK (length(digest) = 64),
  payload     TEXT NOT NULL,
  frozen_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, snapshot_id),
  FOREIGN KEY (task_id) REFERENCES tasks_catalog(task_id) ON DELETE CASCADE,
  CHECK ((scope = 'task' AND scope_ref IS NULL) OR (scope <> 'task' AND scope_ref IS NOT NULL))
);

CREATE TABLE coordination_locks (
  lock_key     TEXT PRIMARY KEY,
  holder_task  TEXT NOT NULL,
  holder_ref   TEXT NOT NULL,
  acquired_at  TEXT NOT NULL,
  expires_at   TEXT
);

CREATE TABLE decisions (
  task_id     TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, decision_id)
);

CREATE TABLE durable_jobs (
  job_id           TEXT NOT NULL,
  task_id          TEXT NOT NULL,
  idempotency_key  TEXT,
  status           TEXT NOT NULL,
  payload          TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (task_id, job_id)
);

CREATE TABLE environment_preparations (
  task_id TEXT NOT NULL REFERENCES tasks_catalog(task_id),
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (task_id, id)
);

CREATE TABLE events (
  task_id     TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (task_id, event_id)
);

CREATE TABLE gate_artifact_logs (
  artifact_key  TEXT NOT NULL,
  step_name     TEXT NOT NULL,
  log_content   BLOB NOT NULL,
  log_digest    TEXT NOT NULL,
  log_bytes     INTEGER NOT NULL,
  PRIMARY KEY (artifact_key, step_name),
  FOREIGN KEY (artifact_key) REFERENCES gate_artifacts(key) ON DELETE CASCADE
);

CREATE TABLE gate_artifacts (
  key               TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  level             TEXT NOT NULL CHECK (level IN ('L1','L2')),
  commit_sha        TEXT NOT NULL,
  plan_digest       TEXT NOT NULL,
  toolchain_digest  TEXT NOT NULL,
  target_ref        TEXT,
  status            TEXT NOT NULL CHECK (status IN ('incomplete','complete')),
  outcome           TEXT NOT NULL CHECK (outcome IN ('unknown','succeeded','failed')),
  payload           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  completed_at      TEXT,
  last_used_at      TEXT NOT NULL
);

CREATE TABLE global_role_messages (
  name       TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (name, message_id),
  FOREIGN KEY (name) REFERENCES global_roles(name)
);

CREATE TABLE global_role_session_sets (
  name       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (name) REFERENCES global_roles(name)
);

CREATE TABLE global_roles (
  name       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE global_sequences (
  name       TEXT PRIMARY KEY,
  high_water INTEGER NOT NULL
);

CREATE TABLE home_meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  home_identity TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE id_sequences (
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  high_water INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind)
);

CREATE TABLE input_requests (
  task_id       TEXT NOT NULL,
  input_id      TEXT NOT NULL,
  status        TEXT NOT NULL,
  blocks        TEXT,
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (task_id, input_id)
);

CREATE TABLE integration_attempts (
  task_id        TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  status         TEXT NOT NULL,
  payload        TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (task_id, integration_id)
);

CREATE TABLE local_resources (
  id TEXT PRIMARY KEY,
  canonical_identity TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL
);

CREATE TABLE mailboxes (
  mailbox_id    INTEGER PRIMARY KEY,
  target_kind   TEXT NOT NULL CHECK (target_kind IN
                  ('task','role','role-runtime','global-role-runtime','operator')),
  task_id       TEXT,
  role_name     TEXT,
  -- The stable mailboxTargetKey string carries the real uniqueness: the column
  -- UNIQUE below cannot, because NULL task_id/role_name (the 'operator' and
  -- 'global-role-runtime' targets) are distinct under SQL NULL semantics.
  target_key    TEXT NOT NULL,
  next_sequence INTEGER NOT NULL,
  processing    TEXT,
  pending       TEXT,
  recent_dedupe_keys TEXT NOT NULL DEFAULT '[]',
  UNIQUE (target_kind, task_id, role_name)
);

CREATE TABLE managed_workspaces (
  owner_kind  TEXT NOT NULL CHECK (owner_kind IN
                ('task','work-item','review-round','integration-attempt','execution-lane')),
  owner_id    TEXT NOT NULL,
  task_id     TEXT,
  path        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);

CREATE TABLE messages (
  task_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, message_id)
);

CREATE TABLE milestones (
  task_id      TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, milestone_id)
);

CREATE TABLE outbox (
  outbox_id  INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  command    TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE plugin_intents (
  task_id TEXT NOT NULL REFERENCES tasks_catalog(task_id),
  plugin_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (task_id, plugin_id)
);

CREATE TABLE plugin_validations (
  task_id TEXT NOT NULL REFERENCES tasks_catalog(task_id),
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (task_id, id)
);

CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE publication_references (
  task_id         TEXT NOT NULL,
  publication_id  TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  provider        TEXT NOT NULL,
  repository      TEXT NOT NULL,
  external_kind   TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  external_key    TEXT NOT NULL,
  state           TEXT NOT NULL,
  verification    TEXT NOT NULL,
  external_url    TEXT,
  title           TEXT,
  source_branch   TEXT,
  target_branch   TEXT,
  local_commit    TEXT,
  remote_commit   TEXT,
  supersedes      TEXT,
  payload         TEXT NOT NULL,
  merged_at       TEXT,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (task_id, publication_id)
);

CREATE TABLE release_workflows (
  task_id     TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, workflow_id)
);

CREATE TABLE resource_registry (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  path        TEXT NOT NULL,
  disposition TEXT NOT NULL,
  task_id     TEXT,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE review_rounds (
  task_id         TEXT NOT NULL,
  review_round_id TEXT NOT NULL,
  status          TEXT NOT NULL,
  payload         TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (task_id, review_round_id)
);

CREATE TABLE role_session_sets (
  task_id     TEXT NOT NULL,
  role_name   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name)
);

CREATE TABLE runtime_session_candidates (
  scope TEXT NOT NULL CHECK(scope IN ('task','global')), task_id TEXT NOT NULL,
  role_name TEXT NOT NULL, agent_id TEXT NOT NULL, adapter_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL, session_updated_at TEXT NOT NULL,
  PRIMARY KEY(scope, task_id, role_name),
  CHECK((scope = 'task' AND length(task_id) > 0) OR (scope = 'global' AND task_id = ''))
);

CREATE TABLE schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      checksum   TEXT NOT NULL
    );

CREATE TABLE session_owners (
  process_key TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('task','global')),
  task_id TEXT, role_name TEXT NOT NULL, agent_id TEXT NOT NULL, native_session_id TEXT,
  provider_root_pid INTEGER, payload TEXT NOT NULL, recorded_at TEXT NOT NULL
);

CREATE TABLE storage_migration_archive (
  migration_version INTEGER NOT NULL,
  family TEXT NOT NULL,
  record_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  content BLOB,
  PRIMARY KEY (migration_version, family, record_key)
);

CREATE TABLE task_projections (
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('leader-failure','operator-notification')),
  payload    TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, kind)
);

CREATE TABLE task_records (
  task_id     TEXT PRIMARY KEY,
  payload     TEXT NOT NULL,
  brief       TEXT,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks_catalog(task_id)
);

CREATE TABLE task_roles (
  task_id     TEXT NOT NULL,
  role_name   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name)
);

CREATE TABLE task_wakes (
  task_id     TEXT NOT NULL,
  wake_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('dispatched','consumed')),
  from_cursor TEXT NOT NULL,
  to_cursor   TEXT NOT NULL,
  reasons     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (task_id, wake_id)
);

CREATE TABLE tasks_catalog (
  task_id     TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  lifecycle   TEXT NOT NULL,
  is_active   INTEGER NOT NULL CHECK (is_active IN (0,1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE telemetry (
  task_id TEXT NOT NULL, role_name TEXT NOT NULL, turn_id TEXT NOT NULL,
  progress_id TEXT NOT NULL, sequence INTEGER, payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name, turn_id, progress_id)
) WITHOUT ROWID;

CREATE TABLE telemetry_aggregate (
  task_id TEXT NOT NULL, role_name TEXT NOT NULL, turn_id TEXT NOT NULL,
  first_at TEXT NOT NULL, last_at TEXT NOT NULL, count INTEGER NOT NULL,
  max_sequence INTEGER, error_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, role_name, turn_id)
) WITHOUT ROWID;

CREATE TABLE turns (
  task_id    TEXT NOT NULL,
  turn_id    TEXT NOT NULL,
  role_name  TEXT NOT NULL,
  status     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, turn_id)
);

CREATE TABLE work_item_candidates (
  task_id      TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, candidate_id)
);

CREATE TABLE work_items (
  task_id      TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  status       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, work_item_id)
);

CREATE INDEX idx_change_sets_project ON change_sets(task_id, project_id);

CREATE UNIQUE INDEX idx_context_snapshots_scope_sequence
  ON context_snapshots(task_id, scope, COALESCE(scope_ref, ''), sequence);

CREATE UNIQUE INDEX idx_durable_jobs_idempotency
  ON durable_jobs(task_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX idx_durable_jobs_request
ON durable_jobs(task_id, json_extract(payload, '$.operation.actorId'),
  json_extract(payload, '$.operation.requestId'));

CREATE INDEX idx_durable_jobs_status ON durable_jobs(status);

CREATE INDEX idx_durable_jobs_task ON durable_jobs(task_id);

CREATE INDEX idx_events_type_time ON events(task_id, type, occurred_at);

CREATE INDEX idx_gate_artifacts_project_commit
  ON gate_artifacts(project_id, commit_sha);

CREATE INDEX idx_gate_artifacts_project_last_used
  ON gate_artifacts(project_id, last_used_at);

CREATE INDEX idx_global_provider_retry ON global_role_session_sets(
  json_extract(payload, '$.providerBinding.retry.status')
) WHERE json_extract(payload, '$.providerBinding.retry.status') IN ('waiting', 'in-flight');

CREATE INDEX idx_global_role_messages_seq ON global_role_messages(name, seq);

CREATE INDEX idx_input_open ON input_requests(task_id, status) WHERE status <> 'resolved';

CREATE INDEX idx_input_requests_open_hot
  ON input_requests(task_id, input_id)
  WHERE status = 'open';

CREATE INDEX idx_mailboxes_ready
  ON mailboxes(target_key)
  WHERE processing IS NOT NULL OR json_type(pending) <> 'null';

CREATE UNIQUE INDEX idx_mailboxes_target_key
  ON mailboxes(target_key);

CREATE INDEX idx_messages_seq ON messages(task_id, seq);

CREATE INDEX idx_outbox_state ON outbox(state, created_at);

CREATE INDEX idx_publication_references_external
  ON publication_references(external_key);

CREATE UNIQUE INDEX idx_publication_references_external_root
  ON publication_references(external_key) WHERE supersedes IS NULL;

CREATE INDEX idx_publication_references_task
  ON publication_references(task_id);

CREATE INDEX idx_resource_registry_disposition
  ON resource_registry(disposition);

CREATE INDEX idx_resource_registry_task
  ON resource_registry(task_id);

CREATE INDEX idx_session_owners_task ON session_owners(task_id, role_name);

CREATE INDEX idx_task_provider_retry ON role_session_sets(
  json_extract(payload, '$.providerBinding.retry.status')
) WHERE json_extract(payload, '$.providerBinding.retry.status') IN ('waiting', 'in-flight');

CREATE INDEX idx_task_wakes_seq ON task_wakes(task_id, seq);

CREATE INDEX idx_tasks_activation_pending ON task_records(task_id)
  WHERE json_extract(payload, '$.activationRequest.disposition') = 'pending';

CREATE INDEX idx_tasks_active ON tasks_catalog(is_active) WHERE is_active = 1;

CREATE INDEX idx_telemetry_turn ON telemetry(task_id, turn_id);

CREATE INDEX idx_turns_planning_active ON turns(task_id, turn_id)
  WHERE status = 'active' AND json_extract(payload, '$.purpose') = 'planning';

CREATE INDEX idx_turns_role_status ON turns(task_id, role_name, status);

CREATE INDEX idx_work_items_status ON work_items(task_id, status);

CREATE INDEX idx_workspaces_task ON managed_workspaces(task_id);

CREATE TRIGGER telemetry_ai AFTER INSERT ON telemetry
BEGIN
  INSERT INTO telemetry_aggregate
    (task_id, role_name, turn_id, first_at, last_at, count, max_sequence, error_count, updated_at)
  VALUES (NEW.task_id, NEW.role_name, NEW.turn_id, NEW.received_at, NEW.received_at,
    1, NEW.sequence,
    CASE WHEN json_valid(NEW.payload)
      AND (COALESCE(json_extract(NEW.payload, '$.error'), '') <> ''
        OR COALESCE(json_extract(NEW.payload, '$.errorKind'), '') <> '')
      THEN 1 ELSE 0 END, NEW.received_at)
  ON CONFLICT(task_id, role_name, turn_id) DO UPDATE SET
    first_at = MIN(telemetry_aggregate.first_at, excluded.first_at),
    last_at = MAX(telemetry_aggregate.last_at, excluded.last_at),
    count = telemetry_aggregate.count + 1,
    max_sequence = CASE WHEN excluded.max_sequence IS NOT NULL
      AND (telemetry_aggregate.max_sequence IS NULL OR excluded.max_sequence > telemetry_aggregate.max_sequence)
      THEN excluded.max_sequence ELSE telemetry_aggregate.max_sequence END,
    error_count = telemetry_aggregate.error_count + excluded.error_count,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER telemetry_au AFTER UPDATE ON telemetry
BEGIN
  UPDATE telemetry_aggregate SET
    last_at = MAX(last_at, NEW.received_at),
    max_sequence = CASE WHEN NEW.sequence IS NOT NULL
      AND (max_sequence IS NULL OR NEW.sequence > max_sequence) THEN NEW.sequence ELSE max_sequence END,
    updated_at = NEW.received_at
  WHERE task_id = NEW.task_id AND role_name = NEW.role_name AND turn_id = NEW.turn_id;
END;
INSERT INTO schema_migrations VALUES(1,'v0.15.0-baseline','2026-09-18T00:00:00.000Z','9a345e0831bb43f4a3cc179057d1634101bed4a4155d9ea218513fc10e0cb042');
INSERT INTO schema_migrations VALUES(2,'job-operation-facts','2026-09-18T00:00:00.000Z','459da4ae18165a5cf745bc1f6434008042bb7fb81a442aaf18ea30669361c87e');
INSERT INTO schema_migrations VALUES(3,'exact-attempt-result-identity','2026-09-18T00:00:00.000Z','66f7be10fc82fb9f5ac4457475e2c3231a185838bd627bea111cb0cac2fd189c');
INSERT INTO schema_migrations VALUES(4,'session-and-process-identity','2026-09-18T00:00:00.000Z','cea73ff671e72a41f08a8921f13c5855a6fa03f0a498b1474f550d135340da1c');
INSERT INTO schema_migrations VALUES(5,'project-resource-artifacts','2026-09-18T00:00:00.000Z','d53e692e8063190d65df88a0f4af2dc4a96fd8307ac0da6af94412056d3a0e3e');
INSERT INTO schema_migrations VALUES(6,'session-endpoint-implementation','2026-09-18T00:00:00.000Z','537d95d1d0142c1b54a0e3c1b16f9342b4553218f00afb10887e5d167dde11a2');
INSERT INTO schema_migrations VALUES(7,'task-facts-and-explicit-acceptance','2026-09-18T00:00:00.000Z','0097e03c11bc6c0b85e4e75fc78c1eb5cca3ed54e38fa2f35f71fb521de6f641');
INSERT INTO schema_migrations VALUES(8,'event-owned-edit-history','2026-09-18T00:00:00.000Z','a5860cfc1436d01efa7759e217020cbc3df9343fa610980e9eeb40d01d39e5fe');
INSERT INTO schema_migrations VALUES(9,'adopted-agent-execution-environment','2026-09-18T00:00:00.000Z','a042720fb03d2f1283ef56c2db9a9969259b69933aee181748452a4e06873bbe');
INSERT INTO schema_migrations VALUES(10,'plugin-validation-evidence','2026-09-18T00:00:00.000Z','72421b330d64077538a63b9f73990d38aa4638e9127753d964fad901b48c71bf');
INSERT INTO schema_migrations VALUES(11,'plugin-enable-intent','2026-09-18T00:00:00.000Z','ee5ae995680bbbad4806413c1195d6913df7d83e5e4b7d508ba82e9bbb3de60d');
INSERT INTO schema_migrations VALUES(12,'draft-planning-and-deferred-activation','2026-09-18T00:00:00.000Z','34e4c2e798b1877248f098a2117917b484b85bbd28e06e3fa0929eb6f0f1527d');
INSERT INTO schema_migrations VALUES(13,'session-authority-and-execution-admission','2026-09-18T00:00:00.000Z','026497c5fc8da4f292c6f1359174fc9509ad03bac62353a2220e9dfacf495786');
INSERT INTO schema_migrations VALUES(14,'acp-session-workspace-configuration','2026-09-18T00:00:00.000Z','264a27d24018ddab600a0dba919447032861dae589e577dbe4a5e33c3bf12bbc');
INSERT INTO schema_migrations VALUES(15,'agent-execution-component','2026-09-18T00:00:00.000Z','bef8cb68d6431b54af1b43f88d4c6ab615851e98139c292e07fbf159e9d212c1');
INSERT INTO schema_migrations VALUES(16,'acp-session-run-configuration','2026-09-18T00:00:00.000Z','cab62273cd6a621125b700eaa150cbe6169acb3e83d884f6eeb2dd58a12a38b8');
INSERT INTO schema_migrations VALUES(17,'session-origin-input-requests','2026-09-18T00:00:00.000Z','7f6c0a8f568adfc93490c54f3eb44a04104976b2d42e3489a7dfba22b564be39');
INSERT INTO schema_migrations VALUES(18,'replaceable-session-process-custody','2026-09-18T00:00:00.000Z','7a0917f3fbebc5bcd7e3ac9742b4f22f71ec088332fdaed10a382ee63b4db4c4');
INSERT INTO schema_migrations VALUES(19,'task-artifacts-local-git','2026-09-18T00:00:00.000Z','ccc103564e449250b4d1eb5ae1a4ee9a2b7ebe853a8f03d67937103743be86a4');
INSERT INTO schema_migrations VALUES(20,'integration-conflict-continuation','2026-09-18T00:00:00.000Z','42ab969e9e4ee9fbcbd88b8ece261c1bd7bb019c8cc1b38a0a1ead5e695fece8');
INSERT INTO schema_migrations VALUES(21,'force-archive-independent-cleanup','2026-09-18T00:00:00.000Z','702532dc60eccbc525cd8280a2c132d6fd6fb9bf2e27808def971c73088430b6');
INSERT INTO schema_migrations VALUES(22,'controller-owned-agent-host-ingress','2026-09-18T00:00:00.000Z','50d54a58c845802696429333e949e964a4c27ca66ac3cfeac87449c24a848213');
INSERT INTO schema_migrations VALUES(23,'unified-message-input-control','2026-09-18T00:00:00.000Z','7a6abbc8d8e144dd0ea8cbacb0a5d745736dabae5d450fa0c8db1e86ed94f7f9');
INSERT INTO schema_migrations VALUES(24,'unify-home-layout','2026-09-18T00:00:00.000Z','67b97eb08acb02be6593ffce0ca1a5418ab603264c76662bcbaa30e81e5b82d5');
INSERT INTO schema_migrations VALUES(25,'collapse-worktree-layout','2026-09-18T00:00:00.000Z','766d8aaa74d3ef7ab5a06cd064efa808488ee632168d0254bd9d8f8e514c998d');
INSERT INTO schema_migrations VALUES(26,'publication-candidate-adoption','2026-09-18T00:00:00.000Z','b24f9b8687e76985586a73b4d646eb8ed73de51dcd19b75acf421ad27b47f64c');
INSERT INTO schema_migrations VALUES(27,'bounded-provider-input-retry','2026-09-18T00:00:00.000Z','163e800dafe7486e75486ba826bd013d5e52810fe6547b94f598fad6d5ecde2c');
INSERT INTO schema_migrations VALUES(28,'current-contract-only-dispatch','2026-09-18T00:00:00.000Z','d7294bf6b890480cfb7b5265477b3ef2f948ed7f8d65d031117988dbe56203fc');
INSERT INTO schema_migrations VALUES(29,'agent-ordered-atomic-integration','2026-09-18T00:00:00.000Z','5768c87b5e738faebbbf8141cae285ccbfe5a79d7374417428a4367bf78e8583');
INSERT INTO schema_migrations VALUES(30,'notification-only-wakes','2026-09-18T00:00:00.000Z','93eaa1c3d9a65e90a924abb5a3a9bffd3e9896e4433400652375c1bca84dab4d');
INSERT INTO schema_migrations VALUES(31,'explicit-review-scope','2026-09-18T00:00:00.000Z','6dee485903827fbb21cc232f9e92c6c793995f34121ba7a1393d83fd08287e8f');
INSERT INTO schema_migrations VALUES(32,'work-item-history-as-events','2026-09-18T00:00:00.000Z','2e719062a11095097c774c389f68cb6d2ee37d291fb37270efd34dfdb7e574b3');
INSERT INTO schema_migrations VALUES(33,'advisory-and-verification-policy','2026-09-18T00:00:00.000Z','3189daad7e88a75f4c7987ba5b1e4723537d15bb5f6986b6a361b1e283baca06');
INSERT INTO schema_migrations VALUES(34,'current-input-contract','2026-09-18T00:00:00.000Z','7f80a64d1566d42b275be346d572270563e505f60e9dcd50fcdb4c7b7ca2cd38');
INSERT INTO schema_migrations VALUES(35,'current-verification-and-owner-contract','2026-09-18T00:00:00.000Z','c0e6bbe525bd9b443fff97c0541eef45f4210b2d9ccc6dd457197a80a2cfd63a');
INSERT INTO schema_migrations VALUES(36,'agent-failure-configuration-context','2026-09-18T00:00:00.000Z','4aafca78cf399f8a7178fae7bf6b54e68909d9c8e53495d27180f0bb8dd227d5');
INSERT INTO schema_migrations VALUES(37,'narrow-agent-failure-context','2026-09-18T00:00:00.000Z','126e8a65b477fb8355f9a7272ffa3ab482c3c0a0e494681fff010e5deb503166');

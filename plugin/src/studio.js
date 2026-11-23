import { AppError, ConflictError, NotFoundError, ValidationError } from './errors.js';
import { ASSET_KINDS, ASSET_KIND_LABELS, GAME_PACKAGE_SCHEMA, normalizeZodIssues } from './schemas.js';
import { normalizeAssetInput } from './content-kinds.js';
import { assembleGamePackage, validateContentAsset, validateGamePackage } from './validation.js';
import { materializeGameVersion } from './materializer.js';
import {
    asJson, clone, hashObject, nowIso, parseJson, pick, uuid, withTransaction,
} from './util.js';

const PROJECT_FIELDS = ['name', 'description', 'status', 'metadata'];

function projectRowToObject(row, extras = {}) {
    if (!row) return null;
    return {
        ...pick(row, ['id', 'name', 'description', 'status', 'created_at', 'updated_at']),
        metadata: parseJson(row.metadata_json, {}),
        ...extras,
    };
}

function assetRowToObject(row, includeData = true) {
    if (!row) return null;
    const output = {
        ...pick(row, [
            'id', 'project_id', 'kind', 'asset_key', 'name', 'status', 'revision',
            'created_at', 'updated_at', 'validated_at', 'reviewed_at', 'reviewed_by', 'published_at',
        ]),
        kindLabel: ASSET_KIND_LABELS[row.kind] ?? row.kind,
    };
    if (includeData) output.data = parseJson(row.data_json, {});
    return output;
}

function latestAssetRows(db, projectId, options = {}) {
    const statusFilter = options.onlyPublished ? "AND status = 'PUBLISHED'" : '';
    return db.prepare(`
        SELECT a.* FROM content_assets a
        JOIN (
            SELECT kind, asset_key, MAX(revision) AS revision
            FROM content_assets
            WHERE project_id = ? ${statusFilter}
            GROUP BY kind, asset_key
        ) latest ON latest.kind = a.kind AND latest.asset_key = a.asset_key AND latest.revision = a.revision
        WHERE a.project_id = ?
        ORDER BY a.kind, a.asset_key
    `).all(projectId, projectId);
}

export function listProjects(db) {
    const projects = db.prepare('SELECT * FROM game_projects ORDER BY updated_at DESC').all();
    return projects.map((project) => {
        const counts = db.prepare(`
            SELECT
                COUNT(*) AS assets,
                SUM(CASE WHEN status = 'DRAFT' THEN 1 ELSE 0 END) AS drafts,
                SUM(CASE WHEN status = 'VALIDATION' THEN 1 ELSE 0 END) AS validation,
                SUM(CASE WHEN status = 'REVIEWED' THEN 1 ELSE 0 END) AS reviewed,
                SUM(CASE WHEN status = 'PUBLISHED' THEN 1 ELSE 0 END) AS published
            FROM content_assets WHERE project_id = ?
        `).get(project.id);
        const latestVersion = db.prepare(`
            SELECT id, version, status, published_at FROM game_versions
            WHERE project_id = ? ORDER BY version DESC LIMIT 1
        `).get(project.id);
        return projectRowToObject(project, { counts, latestVersion: latestVersion ?? null });
    });
}

export function getProject(db, projectId) {
    const row = db.prepare('SELECT * FROM game_projects WHERE id = ?').get(projectId);
    if (!row) throw new NotFoundError(`Project '${projectId}' not found`, 'PROJECT_NOT_FOUND');
    const versions = db.prepare('SELECT id, version, status, package_hash, notes, created_at, published_at FROM game_versions WHERE project_id = ? ORDER BY version DESC').all(projectId);
    const counts = db.prepare(`
        SELECT kind, status, COUNT(*) AS count FROM content_assets WHERE project_id = ? GROUP BY kind, status
    `).all(projectId);
    const campaigns = db.prepare('SELECT COUNT(*) AS count FROM campaigns c JOIN game_versions v ON v.id = c.game_version_id WHERE v.project_id = ?').get(projectId);
    return projectRowToObject(row, {
        versions,
        assetCounts: counts,
        campaignCount: campaigns.count,
        assets: latestAssetRows(db, projectId).map((asset) => assetRowToObject(asset)),
    });
}

export function createProject(db, input, options = {}) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new ValidationError('Project name is required', { field: 'name' });
    const id = input.id ?? uuid('prj_');
    const timestamp = nowIso();
    const metadata = input.metadata && typeof input.metadata === 'object' ? clone(input.metadata) : {};
    withTransaction(db, () => {
        db.prepare(`
            INSERT INTO game_projects (id, name, description, status, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, name, String(input.description ?? ''), input.status ?? 'draft', asJson(metadata), timestamp, timestamp);
    });
    return getProject(db, id);
}

export function updateProject(db, projectId, patch) {
    const project = getProject(db, projectId);
    const timestamp = nowIso();
    db.prepare(`
        UPDATE game_projects SET name = ?, description = ?, status = ?, metadata_json = ?, updated_at = ? WHERE id = ?
    `).run(
        patch.name !== undefined ? String(patch.name).trim() : project.name,
        patch.description !== undefined ? String(patch.description) : project.description,
        patch.status !== undefined ? String(patch.status) : project.status,
        asJson(patch.metadata !== undefined ? { ...project.metadata, ...patch.metadata } : project.metadata),
        timestamp,
        projectId,
    );
    return getProject(db, projectId);
}

export function cloneProject(db, projectId, input = {}) {
    const source = getProject(db, projectId);
    const newId = uuid('prj_');
    const timestamp = nowIso();
    withTransaction(db, () => {
        db.prepare(`
            INSERT INTO game_projects (id, name, description, status, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, 'draft', ?, ?, ?)
        `).run(newId, String(input.name ?? `${source.name} (Copy)`), source.description, asJson(source.metadata), timestamp, timestamp);
        for (const asset of latestAssetRows(db, projectId)) {
            const id = uuid('ast_');
            db.prepare(`
                INSERT INTO content_assets (
                    id, project_id, kind, asset_key, name, status, revision, data_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'DRAFT', 1, ?, ?, ?)
            `).run(id, newId, asset.kind, asset.asset_key, asset.name, asset.data_json, timestamp, timestamp);
            recordContentVersion(db, id, newId, 1, 'DRAFT', parseJson(asset.data_json, {}), 'Copied from project', 'clone', timestamp);
        }
    });
    return getProject(db, newId);
}

export function deleteProject(db, projectId) {
    const project = db.prepare('SELECT id FROM game_projects WHERE id = ?').get(projectId);
    if (!project) throw new NotFoundError(`Project '${projectId}' not found`, 'PROJECT_NOT_FOUND');
    const campaigns = db.prepare(`
        SELECT COUNT(*) AS count FROM campaigns c JOIN game_versions v ON v.id = c.game_version_id WHERE v.project_id = ?
    `).get(projectId);
    if (campaigns.count > 0) {
        throw new ConflictError('Cannot delete a project that has campaigns. Archive it instead.', 'PROJECT_IN_USE', { campaigns: campaigns.count });
    }
    db.prepare('DELETE FROM game_projects WHERE id = ?').run(projectId);
    return { ok: true, id: projectId };
}

function recordContentVersion(db, assetId, projectId, revision, status, data, note, createdBy, timestamp = nowIso()) {
    db.prepare(`
        INSERT INTO content_versions (id, asset_id, project_id, revision, status, data_json, note, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuid('cver_'), assetId, projectId, revision, status, asJson(data), note, createdBy, timestamp);
}

export function listAssets(db, projectId, filters = {}) {
    ensureProject(db, projectId);
    let rows = latestAssetRows(db, projectId);
    if (filters.kind) rows = rows.filter((row) => row.kind === filters.kind);
    if (filters.status) rows = rows.filter((row) => row.status === filters.status);
    if (filters.includeRevisions) {
        rows = db.prepare('SELECT * FROM content_assets WHERE project_id = ? ORDER BY kind, asset_key, revision DESC').all(projectId);
        if (filters.kind) rows = rows.filter((row) => row.kind === filters.kind);
        if (filters.status) rows = rows.filter((row) => row.status === filters.status);
    }
    return rows.map((row) => assetRowToObject(row));
}

export function getAsset(db, assetId) {
    const row = db.prepare('SELECT * FROM content_assets WHERE id = ?').get(assetId);
    if (!row) throw new NotFoundError(`Asset '${assetId}' not found`, 'ASSET_NOT_FOUND');
    const history = db.prepare('SELECT id, revision, status, note, created_by, created_at FROM content_versions WHERE asset_id = ? ORDER BY created_at DESC').all(assetId);
    const reviews = db.prepare('SELECT * FROM content_reviews WHERE asset_id = ? ORDER BY created_at DESC').all(assetId)
        .map((review) => ({ ...review, validation: parseJson(review.validation_json, {}) }));
    const output = assetRowToObject(row);
    const validation = validateContentAsset(row.kind, output.data);
    return { ...output, validation, history, reviews };
}

function ensureProject(db, projectId) {
    const row = db.prepare('SELECT id FROM game_projects WHERE id = ?').get(projectId);
    if (!row) throw new NotFoundError(`Project '${projectId}' not found`, 'PROJECT_NOT_FOUND');
}

export function createAsset(db, projectId, input, options = {}) {
    ensureProject(db, projectId);
    const kind = String(input.kind ?? '').trim();
    if (!ASSET_KINDS.includes(kind)) {
        throw new ValidationError(`Unknown asset kind '${kind}'`, { allowed: ASSET_KINDS });
    }
    if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) {
        throw new ValidationError('Asset data must be a JSON object');
    }
    const data = clone(input.data);
    if (!data.key || typeof data.key !== 'string') throw new ValidationError('Asset data.key is required', { field: 'data.key' });
    const name = String(input.name ?? data.name ?? data.key);
    const validation = validateContentAsset(kind, data);
    const now = nowIso();
    const id = uuid('ast_');
    const result = withTransaction(db, () => {
        const latest = db.prepare(`
            SELECT * FROM content_assets WHERE project_id = ? AND kind = ? AND asset_key = ? ORDER BY revision DESC LIMIT 1
        `).get(projectId, kind, data.key);
        let revision = 1;
        if (latest && latest.status === 'DRAFT') {
            revision = latest.revision;
            db.prepare(`
                UPDATE content_assets SET name = ?, data_json = ?, updated_at = ?, validated_at = NULL,
                    reviewed_at = NULL, reviewed_by = NULL, published_at = NULL
                WHERE id = ?
            `).run(name, asJson(data), now, latest.id);
            recordContentVersion(db, latest.id, projectId, revision, 'DRAFT', data, input.note ?? 'Asset updated', input.createdBy ?? 'studio');
            return latest.id;
        }
        if (latest) revision = latest.revision + 1;
        db.prepare(`
            INSERT INTO content_assets (
                id, project_id, kind, asset_key, name, status, revision, data_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)
        `).run(id, projectId, kind, data.key, name, revision, asJson(data), now, now);
        recordContentVersion(db, id, projectId, revision, 'DRAFT', data, input.note ?? 'Imported', input.createdBy ?? 'studio', now);
        return id;
    });
    return { ...getAsset(db, result), validation };
}

/**
 * Import one designer output, accepting legacy/semantic kind aliases and
 * expanding a world-map payload into a world asset plus scene assets.
 */
export function importAssetBundle(db, projectId, input, options = {}) {
    const normalizedInput = normalizeAssetInput(input);
    return withTransaction(db, () => {
        const created = normalizedInput.assets.map((asset) => {
            return createAsset(db, projectId, {
                kind: asset.kind,
                data: asset.data,
                name: asset.name,
                note: options.note ?? `Imported as ${asset.kind}${normalizedInput.normalization.originalKind ? ` (from ${normalizedInput.normalization.originalKind})` : ''}`,
                createdBy: options.createdBy ?? 'studio',
            });
        });
        const primary = created[0];
        return {
            ...primary,
            createdAssets: created.map((asset) => ({
                id: asset.id,
                kind: asset.kind,
                asset_key: asset.asset_key,
                name: asset.name,
                status: asset.status,
                validation: asset.validation,
            })),
            normalization: {
                originalKind: normalizedInput.normalization.originalKind,
                canonicalKind: normalizedInput.primaryKind,
                inferred: normalizedInput.normalization.inferred,
                warning: normalizedInput.normalization.warning,
                expandedAssets: created.length > 1,
            },
        };
    });
}

export function importAssetItems(db, projectId, items, options = {}) {
    if (!Array.isArray(items) || !items.length) throw new ValidationError('items must be a non-empty array of content assets');
    if (items.length > 50) throw new ValidationError('At most 50 assets can be imported in one batch');
    return withTransaction(db, () => {
        const created = items.map((item) => importAssetBundle(db, projectId, item, options));
        return {
            created,
            primary: created[0],
            summary: {
                items: created.length,
                assets: created.reduce((sum, entry) => sum + entry.createdAssets.length, 0),
                mappedKinds: created
                    .filter((entry) => entry.normalization?.originalKind && entry.normalization.originalKind !== entry.normalization.canonicalKind)
                    .map((entry) => ({
                        from: entry.normalization.originalKind,
                        to: entry.normalization.canonicalKind,
                    })),
                warnings: created.map((entry) => entry.normalization?.warning).filter(Boolean),
            },
        };
    });
}

export function updateAsset(db, assetId, input, options = {}) {
    const current = db.prepare('SELECT * FROM content_assets WHERE id = ?').get(assetId);
    if (!current) throw new NotFoundError(`Asset '${assetId}' not found`, 'ASSET_NOT_FOUND');
    if (current.status !== 'DRAFT') {
        throw new ConflictError('Published or reviewed content is immutable. Create a new revision to edit it.', 'ASSET_IMMUTABLE');
    }
    if (input.data !== undefined && (typeof input.data !== 'object' || input.data === null || Array.isArray(input.data))) {
        throw new ValidationError('Asset data must be a JSON object');
    }
    const data = input.data !== undefined ? clone(input.data) : parseJson(current.data_json, {});
    if (!data.key || typeof data.key !== 'string') throw new ValidationError('Asset data.key is required', { field: 'data.key' });
    if (current.kind === 'world' || current.kind === 'story' || current.kind === 'class' || current.kind === 'rules') {
        // These singleton kinds may keep their key; changing it is only allowed while no other revision uses the new key.
    }
    const name = String(input.name ?? data.name ?? data.key);
    const validation = validateContentAsset(current.kind, data);
    withTransaction(db, () => {
        db.prepare(`
            UPDATE content_assets SET asset_key = ?, name = ?, data_json = ?, updated_at = ?,
                validated_at = NULL, reviewed_at = NULL, reviewed_by = NULL, published_at = NULL
            WHERE id = ?
        `).run(data.key, name, asJson(data), nowIso(), assetId);
        recordContentVersion(db, assetId, current.project_id, current.revision, 'DRAFT', data, input.note ?? 'Asset edited', input.createdBy ?? 'studio');
    });
    return { ...getAsset(db, assetId), validation };
}

const REFERENCE_ARRAY_FIELDS = new Set(['skills', 'startingSkills', 'questsOffered', 'prerequisites', 'eventKeys', 'classes', 'classRestrictions']);

function replaceReferenceKeys(value, oldKey, newKey) {
    if (Array.isArray(value)) return value.map((entry) => replaceReferenceKeys(entry, oldKey, newKey));
    if (!value || typeof value !== 'object') return value;
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string' && entry === oldKey) {
            if (/Key$/.test(key) || ['from', 'to', 'source', 'target'].includes(key)) {
                output[key] = newKey;
                continue;
            }
            if (REFERENCE_ARRAY_FIELDS.has(key)) { output[key] = newKey; continue; }
        }
        if (Array.isArray(entry) && REFERENCE_ARRAY_FIELDS.has(key)) {
            output[key] = entry.map((item) => item === oldKey ? newKey : item);
            continue;
        }
        output[key] = replaceReferenceKeys(entry, oldKey, newKey);
    }
    return output;
}

export function deleteAsset(db, assetId) {
    const current = db.prepare('SELECT * FROM content_assets WHERE id = ?').get(assetId);
    if (!current) throw new NotFoundError(`Asset '${assetId}' not found`, 'ASSET_NOT_FOUND');
    if (current.status === 'PUBLISHED') {
        throw new ConflictError('Published content cannot be deleted. Omit it from the next game version instead.', 'PUBLISHED_ASSET_IMMUTABLE');
    }
    withTransaction(db, () => {
        db.prepare('DELETE FROM content_assets WHERE id = ?').run(assetId);
    });
    return { deleted: true, id: assetId, kind: current.kind, assetKey: current.asset_key, revision: current.revision };
}

export function renameAssetKey(db, assetId, rawKey) {
    const newKey = String(rawKey ?? '').trim();
    if (!/^[a-z][a-z0-9_]*$/.test(newKey)) throw new ValidationError('New key must match ^[a-z][a-z0-9_]*$', { field: 'key' });
    const current = db.prepare('SELECT * FROM content_assets WHERE id = ?').get(assetId);
    if (!current) throw new NotFoundError(`Asset '${assetId}' not found`, 'ASSET_NOT_FOUND');
    if (current.status !== 'DRAFT') throw new ConflictError('Only DRAFT assets can be renamed. Create a new revision first.', 'ASSET_NOT_DRAFT');
    if (newKey === current.asset_key) return getAsset(db, assetId);
    const existing = db.prepare('SELECT id FROM content_assets WHERE project_id = ? AND kind = ? AND asset_key = ?').get(current.project_id, current.kind, newKey);
    if (existing) throw new ConflictError(`An asset with key '${newKey}' already exists`, 'ASSET_KEY_EXISTS');
    const rows = db.prepare(`
        SELECT a.* FROM content_assets a
        JOIN (SELECT project_id, kind, asset_key, MAX(revision) AS revision FROM content_assets WHERE project_id = ? GROUP BY project_id, kind, asset_key) latest
          ON latest.project_id = a.project_id AND latest.kind = a.kind AND latest.asset_key = a.asset_key AND latest.revision = a.revision
    `).all(current.project_id);
    const updates = [];
    for (const row of rows) {
        if (row.id === assetId) continue;
        const data = parseJson(row.data_json, {});
        const next = replaceReferenceKeys(data, current.asset_key, newKey);
        if (JSON.stringify(next) !== JSON.stringify(data)) {
            if (row.status === 'PUBLISHED') {
                throw new ConflictError(`Published ${row.kind}/${row.asset_key} references '${current.asset_key}'. Create a new revision before renaming.`, 'RENAME_PUBLISHED_REFERENCE');
            }
            updates.push({ row, data: next });
        }
    }
    const now = nowIso();
    withTransaction(db, () => {
        const renamedData = { ...parseJson(current.data_json, {}), key: newKey };
        db.prepare('UPDATE content_assets SET asset_key = ?, data_json = ?, updated_at = ? WHERE id = ?')
            .run(newKey, asJson(renamedData), now, assetId);
        for (const { row, data } of updates) {
            db.prepare(`UPDATE content_assets SET data_json = ?, status = 'DRAFT', validated_at = NULL, reviewed_at = NULL, reviewed_by = NULL, updated_at = ? WHERE id = ?`)
                .run(asJson(data), now, row.id);
        }
    });
    return { ...getAsset(db, assetId), renamedReferences: updates.length };
}

export function createAssetRevision(db, assetId, input = {}) {
    const current = getAsset(db, assetId);
    const data = input.data ? clone(input.data) : current.data;
    const now = nowIso();
    const id = uuid('ast_');
    withTransaction(db, () => {
        const latest = db.prepare(`
            SELECT MAX(revision) AS revision FROM content_assets WHERE project_id = ? AND kind = ? AND asset_key = ?
        `).get(current.project_id, current.kind, current.asset_key);
        const revision = Number(latest.revision) + 1;
        db.prepare(`
            INSERT INTO content_assets (
                id, project_id, kind, asset_key, name, status, revision, data_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)
        `).run(id, current.project_id, current.kind, current.asset_key, current.name, revision, asJson(data), now, now);
        recordContentVersion(db, id, current.project_id, revision, 'DRAFT', data, input.note ?? `Revision of ${current.asset_key}`, input.createdBy ?? 'studio', now);
    });
    return getAsset(db, id);
}

export function validateAsset(db, assetId) {
    const asset = getAsset(db, assetId);
    if (asset.status === 'PUBLISHED') return { ...asset, validation: { valid: true, errors: [], warnings: [] } };
    const result = validateContentAsset(asset.kind, asset.data);
    const now = nowIso();
    withTransaction(db, () => {
        db.prepare('UPDATE content_assets SET status = ?, validated_at = ? WHERE id = ?')
            .run(result.valid ? 'VALIDATION' : 'DRAFT', now, assetId);
        db.prepare(`
            INSERT INTO content_reviews (id, asset_id, validation_json, reviewer, decision, note, created_at)
            VALUES (?, ?, ?, 'system', ?, ?, ?)
        `).run(uuid('rev_'), assetId, asJson({ errors: result.errors, warnings: result.warnings }), result.valid ? 'validated' : 'validation_failed', result.valid ? 'Automatic validation passed' : 'Automatic validation failed', now);
        recordContentVersion(db, assetId, asset.project_id, asset.revision, result.valid ? 'VALIDATION' : 'DRAFT', asset.data, 'Automatic validation', 'system', now);
    });
    return { ...getAsset(db, assetId), validation: result };
}

export function reviewAsset(db, assetId, input) {
    const asset = getAsset(db, assetId);
    const reviewer = String(input.reviewer ?? '').trim();
    const decision = String(input.decision ?? '').trim();
    if (!reviewer) throw new ValidationError('Reviewer name is required');
    if (!['approve', 'reject'].includes(decision)) throw new ValidationError("Decision must be 'approve' or 'reject'");
    if (asset.status !== 'VALIDATION') throw new ConflictError('Only assets in VALIDATION can be reviewed', 'INVALID_REVIEW_STATE', { status: asset.status });
    const now = nowIso();
    const validation = validateContentAsset(asset.kind, asset.data);
    if (decision === 'approve' && !validation.valid) throw new ValidationError('Asset no longer passes validation', validation);
    withTransaction(db, () => {
        db.prepare('UPDATE content_assets SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?')
            .run(decision === 'approve' ? 'REVIEWED' : 'DRAFT', now, reviewer, assetId);
        db.prepare(`
            INSERT INTO content_reviews (id, asset_id, validation_json, reviewer, decision, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(uuid('rev_'), assetId, asJson({ errors: validation.errors, warnings: validation.warnings }), reviewer, decision, String(input.note ?? ''), now);
        recordContentVersion(db, assetId, asset.project_id, asset.revision, decision === 'approve' ? 'REVIEWED' : 'DRAFT', asset.data, String(input.note ?? ''), reviewer, now);
    });
    return getAsset(db, assetId);
}

export function publishAsset(db, assetId) {
    const asset = getAsset(db, assetId);
    if (asset.status === 'PUBLISHED') return asset;
    if (asset.status !== 'REVIEWED') throw new ConflictError('Only REVIEWED assets can be published', 'INVALID_PUBLISH_STATE', { status: asset.status });
    const latest = db.prepare(`
        SELECT MAX(revision) AS revision FROM content_assets WHERE project_id = ? AND kind = ? AND asset_key = ?
    `).get(asset.project_id, asset.kind, asset.asset_key);
    if (Number(latest.revision) !== asset.revision) {
        throw new ConflictError('A newer revision exists. Review and publish the latest revision.', 'STALE_REVISION', { latestRevision: latest.revision });
    }
    const now = nowIso();
    withTransaction(db, () => {
        db.prepare("UPDATE content_assets SET status = 'PUBLISHED', published_at = ? WHERE id = ?").run(now, assetId);
        recordContentVersion(db, assetId, asset.project_id, asset.revision, 'PUBLISHED', asset.data, 'Published', asset.reviewed_by ?? 'studio', now);
    });
    return getAsset(db, assetId);
}

function publishedAssetsForBuild(db, projectId) {
    return latestAssetRows(db, projectId, { onlyPublished: true }).map((row) => ({
        ...row,
        data: parseJson(row.data_json, {}),
    }));
}

export function buildGameVersion(db, projectId, input = {}) {
    const project = getProject(db, projectId);
    return withTransaction(db, () => {
        const latest = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM game_versions WHERE project_id = ?').get(projectId);
        const versionNumber = Number(input.version ?? latest.version + 1);
        const assets = publishedAssetsForBuild(db, projectId);
        if (!assets.length) throw new ValidationError('No published content is available to build');
        let pkg;
        try {
            pkg = assembleGamePackage({
                project: { ...project, metadata: project.metadata },
                assets,
                version: versionNumber,
            });
        } catch (error) {
            throw new ValidationError(error.message);
        }
        const report = validateGamePackage(pkg);
        if (!report.valid) {
            throw new ValidationError('Game package validation failed', { report, errors: report.errors });
        }
        const versionId = uuid('ver_');
        const now = nowIso();
        db.prepare(`
            INSERT INTO game_versions (id, project_id, version, status, package_json, package_hash, notes, created_at)
            VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)
        `).run(versionId, projectId, versionNumber, asJson(pkg), hashObject(pkg), String(input.notes ?? ''), now);
        const materialized = materializeGameVersion(db, { projectId, versionId, pkg });
        db.prepare('UPDATE game_projects SET updated_at = ? WHERE id = ?').run(now, projectId);
        return {
            id: versionId,
            projectId,
            version: versionNumber,
            status: 'draft',
            packageHash: hashObject(pkg),
            report,
            materialized: materialized.counts,
        };
    });
}

export function publishGameVersion(db, versionId) {
    const row = db.prepare('SELECT * FROM game_versions WHERE id = ?').get(versionId);
    if (!row) throw new NotFoundError(`Game version '${versionId}' not found`, 'VERSION_NOT_FOUND');
    if (row.status === 'published') return getGameVersion(db, versionId);
    const pkg = parseJson(row.package_json, null);
    const report = validateGamePackage(pkg);
    if (!report.valid) throw new ValidationError('Game package is not valid', { report });
    withTransaction(db, () => {
        db.prepare("UPDATE game_versions SET status = 'published', published_at = ? WHERE id = ?").run(nowIso(), versionId);
        db.prepare('UPDATE game_projects SET updated_at = ? WHERE id = ?').run(nowIso(), row.project_id);
    });
    return getGameVersion(db, versionId);
}

export function rollbackGameVersion(db, versionId, input = {}) {
    const source = getGameVersion(db, versionId, { includePackage: true });
    if (source.status !== 'published') throw new ConflictError('Only a published version can be rolled back to', 'VERSION_NOT_PUBLISHED');
    return withTransaction(db, () => {
        const latest = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM game_versions WHERE project_id = ?').get(source.project_id);
        const versionNumber = Number(latest.version) + 1;
        const pkg = clone(source.package);
        pkg.meta.version = String(versionNumber);
        pkg.meta.rolledBackFrom = source.version;
        pkg.meta.createdAt = nowIso();
        const id = uuid('ver_');
        const now = nowIso();
        db.prepare(`
            INSERT INTO game_versions (id, project_id, version, status, package_json, package_hash, notes, created_at, published_at)
            VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?)
        `).run(id, source.project_id, versionNumber, asJson(pkg), hashObject(pkg), `Rollback of v${source.version}`, now, now);
        materializeGameVersion(db, { projectId: source.project_id, versionId: id, pkg });
        return getGameVersion(db, id);
    });
}

export function getGameVersion(db, versionId, options = {}) {
    const row = db.prepare('SELECT * FROM game_versions WHERE id = ?').get(versionId);
    if (!row) throw new NotFoundError(`Game version '${versionId}' not found`, 'VERSION_NOT_FOUND');
    const output = {
        ...pick(row, ['id', 'project_id', 'version', 'status', 'package_hash', 'notes', 'created_at', 'published_at']),
    };
    if (options.includePackage) output.package = parseJson(row.package_json, null);
    else output.packageMeta = parseJson(row.package_json, {})?.meta ?? null;
    return output;
}

export function listGameVersions(db, projectId) {
    ensureProject(db, projectId);
    return db.prepare('SELECT id, project_id, version, status, package_hash, notes, created_at, published_at FROM game_versions WHERE project_id = ? ORDER BY version DESC').all(projectId);
}

export function exportGameVersion(db, versionId) {
    const version = getGameVersion(db, versionId, { includePackage: true });
    return {
        format: 'strpg.game-package-export',
        exportedAt: nowIso(),
        projectId: version.project_id,
        version: version.version,
        package: version.package,
    };
}

export function importGamePackage(db, input, options = {}) {
    const pkg = input.package ?? input;
    const parsed = GAME_PACKAGE_SCHEMA.safeParse(pkg);
    if (!parsed.success) {
        throw new ValidationError('Imported game package does not match the STRPG schema', {
            errors: normalizeZodIssues(parsed.error),
        });
    }
    const report = validateGamePackage(parsed.data);
    if (!report.valid) throw new ValidationError('Imported game package failed validation', { report });
    const projectName = String(input.projectName ?? parsed.data.meta.title ?? parsed.data.meta.name ?? 'Imported Game');
    const project = createProject(db, {
        name: projectName,
        description: parsed.data.meta.description ?? '',
        metadata: { author: parsed.data.meta.author, importedPackage: true },
    });
    const groups = [
        ['world', [parsed.data.world]],
        ['scene', parsed.data.locations],
        ['event', parsed.data.events],
        ['npc', parsed.data.npcs],
        ['monster', parsed.data.monsters],
        ['equipment', parsed.data.items],
        ['skill', parsed.data.skills],
        ['status_effect', parsed.data.effects],
        ['quest', parsed.data.quests],
        ['story', [parsed.data.story]],
        ['class', parsed.data.classes],
        ['rules', [{ ...parsed.data.rules, key: parsed.data.rules.key ?? 'rules_main', name: parsed.data.rules.name ?? 'Game Rules' }]],
    ];
    for (const [kind, items] of groups) {
        for (const data of items) {
            createAsset(db, project.id, { kind, data, name: data.name ?? data.key, note: 'Imported from game package' }, options);
        }
    }
    return {
        project: getProject(db, project.id),
        importedAssets: groups.reduce((sum, [, items]) => sum + items.length, 0),
        report,
        note: 'Imported assets are DRAFT and must pass validation, review and publication before they can be built.',
    };
}

export function integrityCheck(db, projectId) {
    const project = getProject(db, projectId);
    const issues = [];
    if (!project.assets.length) issues.push({ severity: 'error', code: 'NO_ASSETS', message: 'Project has no content' });
    const published = project.assets.filter((asset) => asset.status === 'PUBLISHED');
    const byKind = (kind) => published.filter((asset) => asset.kind === kind);
    if (byKind('world').length !== 1) issues.push({ severity: 'error', code: 'WORLD_COUNT', message: `Expected exactly one published world, found ${byKind('world').length}` });
    if (byKind('story').length !== 1) issues.push({ severity: 'error', code: 'STORY_COUNT', message: `Expected exactly one published story, found ${byKind('story').length}` });
    if (!byKind('scene').length) issues.push({ severity: 'error', code: 'NO_LOCATIONS', message: 'No published location assets' });
    for (const asset of project.assets) {
        if (asset.status === 'DRAFT') issues.push({ severity: 'warning', code: 'DRAFT_ASSET', message: `Draft asset ${asset.kind}/${asset.asset_key}` });
    }
    for (const version of project.versions) {
        if (version.status === 'draft') issues.push({ severity: 'info', code: 'UNPUBLISHED_VERSION', message: `Game version v${version.version} is not published` });
    }
    return { valid: !issues.some((entry) => entry.severity === 'error'), issues, project: { id: project.id, name: project.name } };
}

export function contentStats(db) {
    const row = db.prepare(`
        SELECT COUNT(*) AS assets,
            SUM(CASE WHEN status = 'DRAFT' THEN 1 ELSE 0 END) AS draft,
            SUM(CASE WHEN status = 'VALIDATION' THEN 1 ELSE 0 END) AS validation,
            SUM(CASE WHEN status = 'REVIEWED' THEN 1 ELSE 0 END) AS reviewed,
            SUM(CASE WHEN status = 'PUBLISHED' THEN 1 ELSE 0 END) AS published
        FROM content_assets
    `).get();
    return {
        projects: db.prepare('SELECT COUNT(*) AS count FROM game_projects').get().count,
        versions: db.prepare('SELECT COUNT(*) AS count FROM game_versions').get().count,
        campaigns: db.prepare('SELECT COUNT(*) AS count FROM campaigns').get().count,
        assets: row.assets ?? 0,
        draft: row.draft ?? 0,
        validation: row.validation ?? 0,
        reviewed: row.reviewed ?? 0,
        published: row.published ?? 0,
    };
}



import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, fileToDataUrl } from '../api.js';
import { ASSET_KINDS, KIND_LABELS, assetTemplate } from '../assetTemplates.js';
import { Badge, Button, Empty, Field, Input, Loading, Modal, Select, Textarea } from '../ui.jsx';
import { NodeGraphEditor } from './NodeGraphEditor.jsx';
import { GenerateAssetModal } from './GenerateAssetModal.jsx';

const LAYERS = ['world', 'region', 'settlement', 'interior', 'room', 'dungeon', 'floor'];
const GROUP_ORDER = [
    ['npc', 'NPCs'], ['event', 'Events'], ['quest', 'Quests'], ['monster', 'Monsters'],
    ['equipment', 'Items'], ['skill', 'Skills'], ['class', 'Classes'], ['rules', 'Rules'],
    ['status_effect', 'Effects'], ['story', 'Stories'],
];
const IMAGE_KINDS = {
    npc: 'npc', character: 'npc', scene: 'scene', location: 'scene', event: 'event',
    quest: 'quest', item: 'equipment', equipment: 'equipment', skill: 'skill',
    monster: 'monster', class: 'class', world: 'world', rules: 'rules', effect: 'status_effect', story: 'story',
};
const QUICK_MODES = {
    scene: { label: 'Scene / area', type: 'scene', prompt: 'Describe a new region, town, dungeon, shop or room. Include parent, atmosphere, connections and encounters.', template: `Type: scene
Key: new_location
Name: New Location
Parent:
Layer: region
Tags: new

Description:
Write the entry here.` },
    npc: { label: 'NPC', type: 'npc', prompt: 'Describe one NPC: role, appearance, personality, motivation, location, functions, quests and shop.', template: `Type: npc
Key: new_npc
Name: New NPC
Parent: location_key
Tags: npc

Description:
Appearance and background.

Personality:
...

Motivation:
...` },
    monster: { label: 'Monster', type: 'monster', prompt: 'Describe one monster: level, combat role, stats, skills, drops and behavior.', template: `Type: monster
Key: new_monster
Name: New Monster
Level: 1
Tags: monster

Description:
Appearance and behavior.` },
    quest: { label: 'Quest', type: 'quest', prompt: 'Describe one quest: main/side/hidden, start, stages, objectives, rewards and failure.', template: `Type: quest
Key: new_quest
Name: New Quest
Tags: quest

Description:
Hook and goal.` },
    item: { label: 'Item / equipment', type: 'item', prompt: 'Describe one item: weapon/armor/accessory/consumable/key item, price, stats and use.', template: `Type: item
Key: new_item
Name: New Item
Kind: weapon
Tags: item

Description:
Appearance and use.` },
    skill: { label: 'Skill', type: 'skill', prompt: 'Describe one active or passive skill: type, MP, cooldown, power, target and effects.', template: `Type: skill
Key: new_skill
Name: New Skill
Tags: skill

Description:
Effect and visual.` },
    event: { label: 'Event', type: 'event', prompt: 'Describe one scene event: trigger, conditions, actions and narrative text.', template: `Type: event
Key: new_event
Name: New Event
Parent: scene_key
Tags: event

Description:
What happens and when.` },
    story: { label: 'Story node / graph', type: 'story', prompt: 'Describe a story beat, branch or ending and how it connects to the current story graph.', template: `Type: story
Key: new_story
Name: New Story
Tags: story

Description:
Story beat.` },
};

const STATUS_WORDS = new Set(['draft', 'validation', 'reviewed', 'published']);


function inferSiteType(scene) {
    if (['indoor', 'town', 'wilderness', 'dungeon'].includes(scene?.siteType)) return scene.siteType;
    const type = String(scene?.type ?? '').toLowerCase();
    if (['dungeon', 'crypt', 'ruin', 'ruins'].includes(type) || ['dungeon', 'floor'].includes(scene?.layer)) return 'dungeon';
    if (['town', 'city', 'village', 'settlement'].includes(type) || scene?.layer === 'settlement') return 'town';
    if (['building', 'shop', 'inn', 'temple', 'house'].includes(type) || ['interior', 'room'].includes(scene?.layer)) return 'indoor';
    return 'wilderness';
}

function childLayer(layer) {
    if (layer === 'settlement') return 'interior';
    if (layer === 'interior') return 'room';
    if (layer === 'dungeon') return 'floor';
    if (layer === 'room') return 'room';
    if (layer === 'floor') return 'floor';
    return 'region';
}

function slug(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function assetNode(asset) {
    return { key: `asset:${asset.id}`, label: asset.data?.name ?? asset.name ?? asset.asset_key, asset };
}

function buildTree(project, assets) {
    const scenes = assets.filter((asset) => asset.kind === 'scene');
    const sceneByKey = new Map(scenes.map((scene) => [scene.data?.key ?? scene.asset_key, scene]));
    const children = new Map();
    for (const scene of scenes) {
        const parent = scene.data?.parentKey;
        const bucket = parent && sceneByKey.has(parent) ? parent : null;
        if (!children.has(bucket)) children.set(bucket, []);
        children.get(bucket).push(scene);
    }
    const renderScene = (scene) => ({
        ...assetNode(scene),
        children: (children.get(scene.data?.key ?? scene.asset_key) ?? []).map(renderScene),
    });
    const roots = (children.get(null) ?? []).map(renderScene);
    const world = assets.find((asset) => asset.kind === 'world');
    const root = { key: 'project', label: project?.name ?? 'Project', children: [] };
    if (world) {
        root.children.push({ ...assetNode(world), label: world.data?.name ?? world.name ?? 'World', children: roots });
    } else {
        root.children.push(...roots);
    }
    const addGroup = (kind, label, entries, subKey = null, subLabel = null) => {
        if (!entries.length) return;
        if (subKey) {
            let folder = root.children.find((entry) => entry.key === `folder:${subKey}`);
            if (!folder) { folder = { key: `folder:${subKey}`, label: `${subLabel} (${entries.length})`, children: [] }; root.children.push(folder); }
            folder.children.push({ key: `folder:${kind}`, label: `${label} (${entries.length})`, children: entries.map(assetNode) });
        } else {
            root.children.push({ key: `folder:${kind}`, label: `${label} (${entries.length})`, children: entries.map(assetNode) });
        }
    };
    const quests = assets.filter((asset) => asset.kind === 'quest');
    for (const [type, label] of [['main', 'Main'], ['side', 'Side'], ['hidden', 'Hidden']]) {
        addGroup(`quest:${type}`, label, quests.filter((quest) => (quest.data?.type ?? 'side') === type), 'quest', 'Quests');
    }
    const questFolder = root.children.find((entry) => entry.key === 'folder:quest');
    if (questFolder) questFolder.label = `Quests (${quests.length})`;
    const items = assets.filter((asset) => asset.kind === 'equipment');
    for (const [kind, label] of [['weapon', 'Weapons'], ['armor', 'Armor'], ['accessory', 'Accessories'], ['consumable', 'Consumables'], ['quest', 'Key Items'], ['material', 'Materials']]) {
        addGroup(`equipment:${kind}`, label, items.filter((item) => (item.data?.kind ?? 'weapon') === kind), 'equipment', 'Items');
    }
    const itemFolder = root.children.find((entry) => entry.key === 'folder:equipment');
    if (itemFolder) itemFolder.label = `Items (${items.length})`;
    for (const [kind, label] of GROUP_ORDER) {
        if (kind === 'quest' || kind === 'equipment') continue;
        const entries = assets.filter((asset) => asset.kind === kind);
        if (entries.length) {
            root.children.push({
                key: `folder:${kind}`, label: `${label} (${entries.length})`,
                children: entries.map(assetNode),
            });
        }
    }
    return root;
}

function findAsset(assets, id) {
    return assets.find((asset) => asset.id === id) ?? null;
}

function uniqueKey(assets, kind, base) {
    const clean = String(base || `${kind}_new`).replace(/[^A-Za-z0-9_.:-]/g, '_');
    const used = new Set(assets.filter((asset) => asset.kind === kind).map((asset) => asset.asset_key));
    if (!used.has(clean)) return clean;
    let index = 2;
    while (used.has(`${clean}_${index}`)) index += 1;
    return `${clean}_${index}`;
}

function collectTreeKeys(node, target = []) {
    if (!node) return target;
    if ((node.children ?? []).length) {
        target.push(node.key);
        for (const child of node.children) collectTreeKeys(child, target);
    }
    return target;
}

async function saveAsset(asset, data, name) {
    let target = asset;
    if (asset.status !== 'DRAFT') {
        target = await api(`/assets/${asset.id}/new-revision`, { method: 'POST' });
    }
    return api(`/assets/${target.id}`, { method: 'PATCH', body: { data, name: name ?? data.name } });
}

function layerForParent(parentLayer, kind) {
    if (kind === 'interior') return 'interior';
    if (kind === 'room') return 'room';
    if (kind === 'dungeon') return 'dungeon';
    if (kind === 'floor') return 'floor';
    return parentLayer === 'settlement' ? 'interior' : 'region';
}

function inferredMode(source, target) {
    if (!source || !target) return 'walk';
    if (target.data?.parentKey === source.data?.key || source.data?.parentKey === target.data?.key) return 'door';
    if (['dungeon', 'floor'].includes(source.data?.layer) && ['dungeon', 'floor'].includes(target.data?.layer)) return 'stairs';
    if (['region', 'settlement'].includes(source.data?.layer) && ['region', 'settlement'].includes(target.data?.layer)) return 'trail';
    return 'walk';
}

export function Workbench({ projectId, project, onRefresh, notify }) {
    const assets = project?.assets ?? [];
    const [selectedId, setSelectedId] = useState(null);
    const [expanded, setExpanded] = useState(() => new Set(['project', 'folder:npc']));
    const [dragAsset, setDragAsset] = useState(null);
    const [dropTarget, setDropTarget] = useState(null);
    const [draft, setDraft] = useState(null);
    const [jsonText, setJsonText] = useState('');
    const [busy, setBusy] = useState(false);
    const [panel, setPanel] = useState('fields');
    const [imageOpen, setImageOpen] = useState(false);
    const [entryOpen, setEntryOpen] = useState(false);
    const [connection, setConnection] = useState(null);
    const [connectMode, setConnectMode] = useState(false);
    const [connectSource, setConnectSource] = useState(null);
    const [disconnectMode, setDisconnectMode] = useState(false);
    const [filterKind, setFilterKind] = useState(null);
    const [search, setSearch] = useState('');
    const [genOpen, setGenOpen] = useState(false);
    const [genSelected, setGenSelected] = useState(null);
    const [genKind, setGenKind] = useState('npc');
    const [newOpen, setNewOpen] = useState(false);


    const ensureReference = async (kind, key, suggestedName = '') => {
        const clean = String(key ?? '').trim();
        if (!clean) return false;
        if (assets.some((asset) => asset.kind === kind && (asset.asset_key === clean || asset.data?.key === clean))) return true;
        if (!window.confirm(`${KIND_LABELS[kind] ?? kind} '${clean}' does not exist. Create a placeholder DRAFT now?`)) return false;
        setBusy(true);
        try {
            const template = assetTemplate(kind);
            const data = { ...template, key: clean, name: suggestedName || clean.replace(/_/g, ' ') };
            await api(`/projects/${projectId}/assets`, { method: 'POST', body: { kind, data, name: data.name } });
            notify?.(`Created placeholder ${kind}/${clean}. Complete it later.`, 'success');
            await onRefresh?.();
            return true;
        } catch (error) {
            notify?.(error.message, 'danger');
            return false;
        } finally {
            setBusy(false);
        }
    };

    const addChild = async (scene) => {
        if (!scene) return;
        const layer = childLayer(scene.data?.layer);
        const suffix = Date.now().toString(36).slice(-5);
        const key = `${scene.data?.key ?? scene.asset_key}_child_${suffix}`;
        const siteType = ['interior', 'room'].includes(layer) ? 'indoor' : layer === 'settlement' ? 'town' : layer === 'dungeon' || layer === 'floor' ? 'dungeon' : 'wilderness';
        setBusy(true);
        try {
            const created = await api(`/projects/${projectId}/assets`, { method: 'POST', body: { kind: 'scene', name: 'New Sub-area', data: {
                key, name: 'New Sub-area', type: layer, siteType, layer, parentKey: scene.data?.key,
                description: '', map: { x: Number(scene.data?.map?.x ?? 200) + 80, y: Number(scene.data?.map?.y ?? 200) + 80 },
                connections: [], spawnPoints: [], discoveredByDefault: false,
            } } });
            notify?.(`Created child area under ${scene.name}.`, 'success');
            await onRefresh?.();
            setSelectedId(created.id);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const toggleSpawn = async (scene) => {
        if (!scene) return;
        setBusy(true);
        try {
            const next = !scene.data?.isSpawn;
            if (next) {
                const others = scenes.filter((entry) => entry.id !== scene.id && entry.data?.layer === scene.data?.layer && entry.data?.isSpawn);
                for (const other of others) {
                    await saveAsset(other, { ...other.data, isSpawn: false }, other.name);
                }
            }
            const updated = await saveAsset(scene, { ...scene.data, isSpawn: next }, scene.name);
            notify?.(next ? `Marked as the spawn point for layer ${scene.data?.layer ?? 'unknown'}.` : 'Spawn point cleared.', 'success');
            await refreshAndSelect(updated.id);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const selected = findAsset(assets, selectedId);
    const filteredAssets = useMemo(() => {
        const query = search.trim().toLowerCase();
        return assets.filter((asset) => {
            if (filterKind && asset.kind !== filterKind) return false;
            if (!query) return true;
            return `${asset.name} ${asset.asset_key} ${asset.data?.name ?? ''} ${asset.status}`.toLowerCase().includes(query);
        });
    }, [assets, filterKind, search]);
    const tree = useMemo(() => buildTree(project, filteredAssets), [project, filteredAssets]);
    const kindCounts = useMemo(() => assets.reduce((counts, asset) => {
        counts[asset.kind] = (counts[asset.kind] ?? 0) + 1;
        return counts;
    }, {}), [assets]);

    useEffect(() => {
        if (!selected) {
            setDraft(null);
            return;
        }
        const nextDraft = { ...selected.data, key: selected.data?.key ?? selected.asset_key, name: selected.name, tagsText: (selected.data?.tags ?? []).join(', ') };
        setDraft(nextDraft);
        setJsonText(JSON.stringify(nextDraft, (key, value) => key === 'tagsText' ? undefined : value, 2));
        setPanel(selected.kind === 'scene' || selected.kind === 'story' || selected.kind === 'quest' ? 'fields' : 'fields');
        setConnectSource(null);
        setConnectMode(false);
    }, [selected?.id, selected?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

    const scenes = assets.filter((asset) => asset.kind === 'scene');
    const selectedScenes = selected?.kind === 'scene' ? scenes : [];

    const toggle = (key) => setExpanded((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });

    const updateDraft = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
    const updateData = (key, value) => setDraft((current) => ({ ...current, [key]: value }));

    const refreshAndSelect = async (id) => {
        await onRefresh?.();
        if (id) setSelectedId(id);
    };

    const persistAsset = async (asset, data, name) => {
        const updated = await saveAsset(asset, data, name ?? asset.name);
        notify?.('DRAFT saved.', 'success');
        await refreshAndSelect(updated.id);
        return updated;
    };

    const persist = async (data, name = selected?.name) => {
        return persistAsset(selected, data, name);
    };

    const saveDraft = async () => {
        if (!selected || !draft) return;
        setBusy(true);
        try {
            const tags = String(draft.tagsText ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
            const data = { ...draft, tags };
            delete data.tagsText;
            await persist(data, draft.name);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const validateSelected = async () => {
        if (!selected) return;
        setBusy(true);
        try {
            await api(`/assets/${selected.id}/validate`, { method: 'POST', body: {} });
            notify?.('Validation complete.', 'success');
            await refreshAndSelect(selected.id);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const reviewSelected = async () => {
        if (!selected) return;
        setBusy(true);
        try {
            await api(`/assets/${selected.id}/review`, { method: 'POST', body: { reviewer: 'Workbench', decision: 'approve', note: 'Reviewed from Workbench' } });
            notify?.('Review approved.', 'success');
            await refreshAndSelect(selected.id);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const publishSelected = async () => {
        if (!selected) return;
        setBusy(true);
        try {
            await api(`/assets/${selected.id}/publish`, { method: 'POST', body: {} });
            notify?.('Published.', 'success');
            await refreshAndSelect(selected.id);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const newRevision = async () => {
        if (!selected) return;
        setBusy(true);
        try {
            const updated = await api(`/assets/${selected.id}/new-revision`, { method: 'POST' });
            notify?.(`Created DRAFT revision r${updated.revision}. Edit, validate, approve and publish it.`, 'success');
            await refreshAndSelect(updated.id);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const dropOn = async (target) => {
        setDropTarget(null);
        if (!dragAsset || !target || dragAsset.id === target.id) return;
        if (target.kind !== 'scene') {
            notify?.('Drop onto a Scene to attach content.', 'warning');
            return;
        }
        try {
            if (dragAsset.kind === 'scene') {
                let cursor = target.data?.parentKey;
                const keys = new Set([target.data?.key]);
                while (cursor) {
                    if (cursor === dragAsset.data?.key) throw new Error('A scene cannot be moved under its own child');
                    if (keys.has(cursor)) break;
                    keys.add(cursor);
                    cursor = scenes.find((scene) => scene.data?.key === cursor)?.data?.parentKey;
                }
                await persistAsset(dragAsset, { ...dragAsset.data, parentKey: target.data.key }, dragAsset.name);
                notify?.(`Moved ${dragAsset.name} under ${target.name}.`, 'success');
            } else if (dragAsset.kind === 'npc') {
                await persistAsset(dragAsset, { ...dragAsset.data, locationKey: target.data?.key }, dragAsset.name);
                notify?.(`Attached ${dragAsset.name} to ${target.name}.`, 'success');
            } else if (dragAsset.kind === 'event') {
                await persistAsset(dragAsset, { ...dragAsset.data, scope: 'scene', sceneKey: target.data?.key }, dragAsset.name);
                notify?.(`Attached ${dragAsset.name} to ${target.name}.`, 'success');
            } else {
                notify?.('Only Scene, NPC and Event entries can be dropped onto a Scene.', 'warning');
            }
        } catch (error) {
            notify?.(error.message, 'danger');
        }
    };


    const disconnectConnection = async (source, target) => {
        if (!source || !target) return;
        if (!window.confirm(`Remove the connection between ${source.data?.name} and ${target.data?.name}?`)) return;
        setBusy(true);
        try {
            const sourceData = { ...source.data, connections: (source.data?.connections ?? []).filter((entry) => entry.toKey !== target.data?.key) };
            const targetData = target.data?.connections ? { ...target.data, connections: (target.data.connections ?? []).filter((entry) => entry.toKey !== source.data?.key) } : null;
            await saveAsset(source, sourceData, source.name);
            if (targetData) await saveAsset(target, targetData, target.name);
            notify?.(`Disconnected ${source.name} and ${target.name}.`, 'success');
            await refreshAndSelect(source.id);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const createConnection = async () => {
        if (!connection) return;
        const { source, target, mode, cost, bidirectional } = connection;
        const existing = (source.data.connections ?? []).filter((entry) => entry.toKey !== target.data?.key);
        const data = {
            ...source.data,
            connections: [...existing, { toKey: target.data?.key, mode, travelCost: Number(cost), bidirectional, label: `${mode} to ${target.name}` }],
        };
        setBusy(true);
        try {
            await persistAsset(source, data, source.name);
            setConnection(null);
            setConnectSource(null);
            setConnectMode(false);
            notify?.(`Connected ${source.name} → ${target.name}.`, 'success');
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };





    const importChatCharacter = async () => {
        try {
            const ctx = globalThis.SillyTavern?.getContext?.();
            const character = ctx?.characters?.[ctx.characterId] ?? ctx?.characters?.[0];
            if (!character?.name) throw new Error('No active SillyTavern character is available');
            const key = slug(character.name) || `npc_${Date.now().toString(36).slice(-5)}`;
            const data = {
                key, name: character.name, title: 'Imported from chat',
                description: character.description || '', personality: character.personality || '',
                motivation: character.scenario || '', locationKey: 'REPLACE_WITH_LOCATION',
                portrait: character.avatar ? `/characters/${character.avatar}` : null,
                interactions: character.first_mes ? [{ key: 'talk', label: 'Talk', type: 'talk', description: '', actions: [], dialogue: [character.first_mes] }] : [],
                shop: null, questsOffered: [], important: true, joinable: false,
                tags: Array.isArray(character.tags) ? character.tags : [],
                tavern: character.avatar ? { avatar: character.avatar, importedAt: new Date().toISOString() } : undefined,
            };
            setBusy(true);
            const created = await api(`/projects/${projectId}/assets`, { method: 'POST', body: { kind: 'npc', data, name: data.name } });
            notify?.(`Imported ${data.name} as an important NPC DRAFT. Set its location before publishing.`, 'success');
            await onRefresh?.();
            setSelectedId(created.id);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };


    const exportQuickReplies = async () => {
        if (!selected || selected.kind !== 'npc') return;
        const interactions = selected.data?.interactions ?? [];
        if (!interactions.length) { notify?.('This NPC has no interactions to export.', 'warning'); return; }
        try {
            const ctx = globalThis.SillyTavern?.getContext?.();
            if (!ctx?.getRequestHeaders) throw new Error('SillyTavern request context is unavailable');
            const set = {
                version: 2, name: `STRPG - ${selected.data?.name ?? selected.name}`, disableSend: false, placeBeforeInput: false, injectInput: false,
                color: '', onlyBorderColor: false,
                qrList: interactions.map((interaction, index) => ({
                    id: index + 1,
                    label: String(interaction.label ?? interaction.type ?? 'Talk').slice(0, 40),
                    message: interaction.dialogue?.[0] ?? `I would like to ${String(interaction.label ?? interaction.type ?? 'talk').toLowerCase()}.`,
                    title: interaction.description ?? '', showLabel: true, autoExecute: false, executeOnStartOnly: false,
                    executeOnUser: false, executeOnAi: false, executeOnChatChange: false, executeOnGroupMemberDraft: false, executeOnNewChat: false, automationId: '',
                })),
            };
            const response = await fetch('/api/quick-replies/save', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify(set) });
            if (!response.ok) throw new Error(`Quick Replies save failed (HTTP ${response.status})`);
            notify?.(`Saved Quick Replies set '${set.name}'. Open Quick Replies to enable it.`, 'success');
        } catch (error) {
            notify?.(error.message, 'danger');
        }
    };

    const importToTavern = async () => {
        if (!selected || selected.kind !== 'npc') return;
        setBusy(true);
        try {
            const result = await api(`/assets/${selected.id}/tavern-import`, { method: 'POST', body: {} });
            notify?.(result.avatar ? `Imported ${result.name} to SillyTavern as ${result.avatar}.` : `Imported ${result.name} to SillyTavern.`, 'success');
            if (result.persisted) await refreshAndSelect(selected.id);
            else setDraft((current) => current ? { ...current, tavern: { avatar: result.avatar, importedAt: result.importedAt } } : current);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const renameSelected = async () => {
        if (!selected || selected.status !== 'DRAFT') return;
        const next = window.prompt('New key for this DRAFT asset:', selected.asset_key);
        if (!next || next === selected.asset_key) return;
        setBusy(true);
        try {
            const updated = await api(`/assets/${selected.id}/rename`, { method: 'POST', body: { key: next } });
            notify?.(`Renamed key to ${next}.${updated.renamedReferences ? ` Updated ${updated.renamedReferences} references.` : ''}`, 'success');
            await refreshAndSelect(updated.id);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const deleteSelected = async () => {
        if (!selected || selected.status === 'PUBLISHED') return;
        if (!window.confirm(`Delete DRAFT ${selected.kind}/${selected.asset_key}? This cannot be undone.`)) return;
        setBusy(true);
        try {
            await api(`/assets/${selected.id}`, { method: 'DELETE' });
            setSelectedId(null);
            setDraft(null);
            notify?.('DRAFT deleted.', 'success');
            await onRefresh?.();
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const createKind = async (kind) => {
        setNewOpen(false);
        if (!KIND_LABELS[kind]) return;
        setBusy(true);
        try {
            const template = assetTemplate(kind);
            const data = { ...template, key: uniqueKey(assets, kind, template.key) };
            const anchor = selected?.kind === 'scene' ? selected.data : null;
            if (kind === 'scene') {
                data.parentKey = anchor?.key ?? null;
                data.layer = anchor ? childLayer(anchor.layer) : 'region';
                data.type = data.layer;
                data.siteType = ['interior', 'room'].includes(data.layer) ? 'indoor' : ['dungeon', 'floor'].includes(data.layer) ? 'dungeon' : data.layer === 'settlement' ? 'town' : 'wilderness';
                data.description = '';
            }
            if (kind === 'npc') data.locationKey = anchor?.key ?? scenes[0]?.data?.key ?? 'REPLACE_WITH_LOCATION';
            if (kind === 'event') data.sceneKey = anchor?.key ?? scenes[0]?.data?.key ?? 'REPLACE_WITH_SCENE';
            const created = await api(`/projects/${projectId}/assets`, {
                method: 'POST',
                body: { kind, data, name: data.name, note: 'Created in Workbench' },
            });
            notify?.(`Created ${KIND_LABELS[kind]} DRAFT ${data.key}.`, 'success');
            await onRefresh?.();
            setSelectedId(created.id);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const duplicateSelected = async () => {
        if (!selected) return;
        setBusy(true);
        try {
            const data = JSON.parse(JSON.stringify(selected.data));
            data.key = uniqueKey(assets, selected.kind, `${selected.asset_key}_copy`);
            data.name = `${selected.data?.name ?? selected.name} Copy`;
            if (data.tavern) delete data.tavern;
            const created = await api(`/projects/${projectId}/assets`, {
                method: 'POST',
                body: { kind: selected.kind, data, name: data.name, note: `Duplicated from ${selected.asset_key}` },
            });
            notify?.(`Duplicated as ${data.key}.`, 'success');
            await onRefresh?.();
            setSelectedId(created.id);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const openGenerateCreate = () => {
        setGenSelected(null);
        setGenKind(selected?.kind ?? 'npc');
        setGenOpen(true);
    };

    const openGenerateImprove = () => {
        if (!selected) return;
        setGenSelected(selected);
        setGenKind(selected.kind);
        setGenOpen(true);
    };

    const applyGenerated = (data) => {
        setDraft({ ...data, tagsText: (data.tags ?? []).join(', ') });
        setJsonText(JSON.stringify(data, null, 2));
        setPanel('fields');
        notify?.('AI result applied to the editor. Review it, then Save DRAFT.', 'success');
    };

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.key !== 'Delete' && event.key !== 'Backspace') return;
            const tag = event.target?.tagName;
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || event.target?.isContentEditable) return;
            if (!selected || selected.status === 'PUBLISHED' || busy) return;
            event.preventDefault();
            void deleteSelected();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selected?.id, selected?.status, busy]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!project) return <Loading label="Loading Workbench..." />;

    return (
        <div className="strpg-wb-page">
            <header className="strpg-wb-bar">
                <div className="strpg-wb-bar-title">
                    <span className="strpg-eyebrow">STUDIO · WORLD WORKBENCH</span>
                    <h2>{project.name}</h2>
                    <div className="strpg-wb-bar-meta">
                        <Badge>{assets.length} assets</Badge>
                        <Badge tone="gold">{kindCounts.scene ?? 0} scenes</Badge>
                        <Badge tone="info">{kindCounts.npc ?? 0} NPCs</Badge>
                        <Badge>{kindCounts.quest ?? 0} quests</Badge>
                        <Badge>{kindCounts.monster ?? 0} monsters</Badge>
                    </div>
                </div>
                <div className="strpg-wb-bar-actions">
                    <div className="strpg-wb-new">
                        <Button variant="ghost" onClick={() => setNewOpen((value) => !value)}>＋ New DRAFT</Button>
                        {newOpen && (
                            <div className="strpg-wb-new-menu">
                                <div className="strpg-wb-new-menu-head">CREATE FROM TEMPLATE</div>
                                {ASSET_KINDS.map(([kind, label]) => (
                                    <button type="button" key={kind} onClick={() => createKind(kind)}>
                                        <strong>{label}</strong>
                                        <span>new {kind.replace('_', ' ')} DRAFT</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    <Button variant="gold" onClick={openGenerateCreate}>✦ Generate with AI</Button>
                    <Button variant="ghost" onClick={() => setEntryOpen(true)}>Import Entry</Button>
                    <Button variant="ghost" onClick={() => setImageOpen(true)}>Images</Button>
                    <Button variant="ghost" onClick={importChatCharacter}>Chat Character</Button>
                </div>
            </header>
            <div className="strpg-wb-db">
                <div className="strpg-wb-db-label">DATABASE</div>
                <div className="strpg-wb-db-kinds">
                    <button type="button" className={filterKind === null ? 'active' : ''} onClick={() => setFilterKind(null)}>
                        All <span>{assets.length}</span>
                    </button>
                    {ASSET_KINDS.map(([kind, label]) => (
                        <button
                            type="button"
                            key={kind}
                            className={filterKind === kind ? 'active' : ''}
                            onClick={() => setFilterKind(filterKind === kind ? null : kind)}
                            disabled={!kindCounts[kind]}
                        >
                            {label} <span>{kindCounts[kind] ?? 0}</span>
                        </button>
                    ))}
                </div>
                <div className="strpg-wb-search">
                    <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, key or status…" />
                    {search && <button type="button" onClick={() => setSearch('')} title="Clear search">×</button>}
                </div>
            </div>
            <div className="strpg-workbench">
                <aside className="strpg-workbench-tree">
                    <header>
                        <div className="strpg-row between">
                            <span className="strpg-eyebrow">WORLD TREE</span>
                            <span className="strpg-muted">{filteredAssets.length} / {assets.length}</span>
                        </div>
                        <strong>{project.name}</strong>
                        <div className="strpg-wb-tree-actions">
                            <Button size="sm" variant="ghost" onClick={() => setExpanded(new Set(collectTreeKeys(tree)))}>Expand</Button>
                            <Button size="sm" variant="ghost" onClick={() => setExpanded(new Set(['project']))}>Collapse</Button>
                            <Button size="sm" variant="gold" onClick={() => createKind('scene')}>+ Area</Button>
                        </div>
                    </header>
                <div className="strpg-tree-scroll">
                    <TreeNode
                        node={tree} depth={0} expanded={expanded} toggle={toggle}
                        selectedId={selectedId} onSelect={setSelectedId}
                        onDragStart={setDragAsset} onDrop={dropOn} dropTarget={dropTarget} setDropTarget={setDropTarget} onAddChild={addChild} onToggleSpawn={toggleSpawn}
                    />
                </div>
            </aside>
            <main className="strpg-workbench-main">
                {!selected ? (
                    <Empty
                        title="Select an entry, or create one"
                        icon="▤"
                        action={(
                            <div className="strpg-row center">
                                <Button variant="gold" onClick={openGenerateCreate}>✦ Generate with AI</Button>
                                <Button onClick={() => setNewOpen(true)}>New DRAFT</Button>
                            </div>
                        )}
                    >
                        The tree is the world hierarchy: scenes nest by parent, everything else lives in database folders.
                    </Empty>
                ) : (
                    <>
                        <header className="strpg-workbench-toolbar">
                            <div className="strpg-wb-selected">
                                <span className="strpg-eyebrow">{KIND_LABELS[selected.kind] ?? selected.kind} · {selected.status}</span>
                                <h2>{selected.data?.name ?? selected.name}</h2>
                                <div className="strpg-wb-selected-meta">
                                    <span className="strpg-wb-key">{selected.asset_key}</span>
                                    <span>r{selected.revision}</span>
                                    <span>{selected.kind}</span>
                                </div>
                            </div>
                            <div className="strpg-wb-selected-actions">
                                <Button size="sm" variant="ghost" onClick={openGenerateImprove} disabled={busy || selected.status !== 'DRAFT'} title={selected.status !== 'DRAFT' ? 'Create a new DRAFT revision before AI rewrite' : 'Rewrite this entry with the AI content interface'}>✦ AI Rewrite</Button>
                                <Button size="sm" variant="ghost" onClick={duplicateSelected} disabled={busy} title="Duplicate as a new DRAFT">Duplicate</Button>
                                {selected.status !== 'DRAFT' && <Button size="sm" variant="gold" onClick={newRevision} disabled={busy} title="Fork this immutable revision into a new editable DRAFT">New Revision</Button>}
                                <Button size="sm" onClick={saveDraft} disabled={busy || selected.status !== 'DRAFT'} title={selected.status !== 'DRAFT' ? 'Create a new DRAFT revision before editing' : 'Save the current DRAFT'}>Save DRAFT</Button>
                                <Button size="sm" onClick={validateSelected} disabled={busy || selected.status !== 'DRAFT'} title="Validation is available for DRAFT assets">Validate</Button>
                                <Button size="sm" onClick={reviewSelected} disabled={busy || selected.status !== 'VALIDATION'} title="Approve only after validation">Approve</Button>
                                <Button size="sm" variant="gold" onClick={publishSelected} disabled={busy || selected.status !== 'REVIEWED'} title="Publish only after approval">Publish</Button>
                                <Button size="sm" variant="ghost" onClick={renameSelected} disabled={busy || selected.status !== 'DRAFT'} title="Rename key and update references">Rename</Button>
                                <Button size="sm" variant="danger" onClick={deleteSelected} disabled={busy || selected.status === 'PUBLISHED'} title={selected.status === 'PUBLISHED' ? 'Published content is immutable' : 'Delete DRAFT (Delete key)'}>Delete</Button>
                            </div>
                        </header>
                        <div className="strpg-wb-lifecycle">
                            {['DRAFT', 'VALIDATION', 'REVIEWED', 'PUBLISHED'].map((step, index) => {
                                const order = ['DRAFT', 'VALIDATION', 'REVIEWED', 'PUBLISHED'];
                                const current = order.indexOf(selected.status);
                                return (
                                    <span key={step} className={`${step === selected.status ? 'current' : ''} ${index < current ? 'done' : ''}`}>
                                        <i>{index + 1}</i>{step}
                                    </span>
                                );
                            })}
                            <em>{selected.status === 'DRAFT' ? 'Save, validate, approve, then publish' : 'Immutable revision · create a new revision to edit'}</em>
                        </div>
                        <div className="strpg-workbench-tabs">
                            <button type="button" className={panel === 'fields' ? 'active' : ''} onClick={() => setPanel('fields')}>Entry</button>
                            {(selected.kind === 'scene') && <button type="button" className={panel === 'graph' ? 'active' : ''} onClick={() => setPanel('graph')}>Connections</button>}
                            {(selected.kind === 'story' || selected.kind === 'quest') && <button type="button" className={panel === 'graph' ? 'active' : ''} onClick={() => setPanel('graph')}>Node Graph</button>}
                            <button type="button" className={panel === 'json' ? 'active' : ''} onClick={() => setPanel('json')}>JSON</button>
                            <span className="strpg-workbench-next">{selected.status === 'DRAFT' ? 'Next: Validate' : selected.status === 'VALIDATION' ? 'Next: Approve' : selected.status === 'REVIEWED' ? 'Next: Publish' : 'Published · immutable'}</span>
                        </div>
                        {panel === 'fields' && draft && (
                            <EntryFields asset={selected} draft={draft} updateDraft={updateDraft} updateData={updateData} scenes={scenes} assets={assets} ensureReference={ensureReference} onImportTavern={importToTavern} onExportQuickReplies={exportQuickReplies} />
                        )}
                        {panel === 'graph' && selected.kind === 'scene' && (
                            <SceneGraph
                                scenes={selectedScenes}
                                selectedId={selectedId}
                                connectMode={connectMode}
                                connectSource={connectSource}
                                onToggleConnect={() => { setConnectMode((value) => { const next = !value; if (next) setDisconnectMode(false); return next; }); setConnectSource(null); }}
                                disconnectMode={disconnectMode}
                                onToggleDisconnect={() => { setDisconnectMode((value) => { const next = !value; if (next) { setConnectMode(false); setConnectSource(null); } return next; }); }}
                                onDisconnect={disconnectConnection}
                                onSelect={setSelectedId}
                                onNodeClick={(scene) => {
                                    if (!connectMode) { setSelectedId(scene.id); return; }
                                    if (!connectSource) { setConnectSource(scene); return; }
                                    if (connectSource.id === scene.id) { setConnectSource(null); return; }
                                    setConnection({
                                        source: connectSource,
                                        target: scene,
                                        mode: inferredMode(connectSource, scene),
                                        cost: 0,
                                        bidirectional: true,
                                    });
                                }}
                            />
                        )}
                        {panel === 'graph' && (selected.kind === 'story' || selected.kind === 'quest') && (
                            <div className="strpg-workbench-graph">
                                <NodeGraphEditor
                                    asset={selected}
                                    notify={notify}
                                    onApply={async (data, options) => {
                                        const updated = await saveAsset(selected, data, data.name ?? selected.name);
                                        if (options?.validate) {
                                            await api(`/assets/${updated.id}/validate`, { method: 'POST', body: {} });
                                        }
                                        await refreshAndSelect(updated.id);
                                        return updated;
                                    }}
                                    onNewRevision={async () => {
                                        const updated = await api(`/assets/${selected.id}/new-revision`, { method: 'POST' });
                                        await refreshAndSelect(updated.id);
                                    }}
                                />
                            </div>
                        )}
                        {panel === 'json' && draft && (
                            <div className="strpg-workbench-json">
                                <Field label="Structured JSON" hint="Edit freely, then Apply JSON. Save remains DRAFT and still requires validation.">
                                    <Textarea rows={24} value={jsonText} onChange={(event) => setJsonText(event.target.value)} />
                                </Field>
                                <div className="strpg-row">
                                    <Button size="sm" onClick={() => {
                                        try {
                                            const parsed = JSON.parse(jsonText);
                                            setDraft({ ...parsed, tagsText: (parsed.tags ?? []).join(', ') });
                                            notify?.('JSON applied to the editor. Save DRAFT to persist.', 'success');
                                        } catch (error) {
                                            notify?.(`Invalid JSON: ${error.message}`, 'danger');
                                        }
                                    }}>Apply JSON</Button>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </main>
            <QuickEntryModal
                open={entryOpen}
                projectId={projectId}
                onClose={() => setEntryOpen(false)}
                onRefresh={onRefresh}
                onSaved={(asset) => { setSelectedId(asset.id); setEntryOpen(false); }}
                notify={notify}
            />
            <ImageImportModal
                open={imageOpen}
                assets={assets}
                onClose={() => setImageOpen(false)}
                onRefresh={onRefresh}
                notify={notify}
            />
            <ConnectionModal
                value={connection}
                setValue={setConnection}
                onClose={() => setConnection(null)}
                onSave={createConnection}
            />
        </div>
        <GenerateAssetModal
            open={genOpen}
            project={project}
            projectId={projectId}
            assets={assets}
            selected={genSelected}
            initialKind={genKind}
            onClose={() => setGenOpen(false)}
            onSaved={async (asset) => {
                await onRefresh?.();
                if (asset?.id) setSelectedId(asset.id);
            }}
            onApply={applyGenerated}
            notify={notify}
        />
    </div>
    );
}

function TreeNode({ node, depth, expanded, toggle, selectedId, onSelect, onDragStart, onDrop, dropTarget, setDropTarget, onAddChild, onToggleSpawn }) {
    if (!node) return null;
    const isFolder = !node.asset;
    const hasChildren = (node.children ?? []).length > 0;
    const isOpen = expanded.has(node.key) || node.asset?.kind === 'world';
    return (
        <div className="strpg-tree-node">
            <div
                className={`strpg-tree-row ${selectedId === node.asset?.id ? 'selected' : ''} ${dropTarget === node.asset?.id ? 'drop' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                draggable={Boolean(node.asset)}
                onDragStart={() => node.asset && onDragStart(node.asset)}
                onDragOver={(event) => { if (node.asset) { event.preventDefault(); setDropTarget(node.asset.id); } }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(event) => { event.preventDefault(); onDrop(node.asset); }}
                onClick={() => {
                    if (hasChildren) toggle(node.key);
                    if (node.asset) onSelect(node.asset.id);
                }}
                title={node.asset?.asset_key}
            >
                <span className="strpg-tree-caret">{hasChildren ? (isOpen ? '▾' : '▸') : '·'}</span>
                <span className="strpg-tree-icon">{isFolder ? '▣' : node.asset.kind === 'scene' ? '⌘' : '◈'}</span>
                <span className="strpg-tree-label">{node.label}</span>
                {node.asset && <span className={`strpg-tree-status ${node.asset.status?.toLowerCase()}`}>{node.asset.status?.[0] ?? ''}</span>}
                {node.asset?.kind === 'scene' && (
                    <span className="strpg-tree-actions">
                        <button type="button" title="Add child area" onClick={(event) => { event.stopPropagation(); onAddChild(node.asset); }}>+</button>
                        <button type="button" title="Toggle spawn point" className={node.asset.data?.isSpawn ? 'spawn active' : 'spawn'} onClick={(event) => { event.stopPropagation(); onToggleSpawn(node.asset); }}>S</button>
                    </span>
                )}
            </div>
            {hasChildren && isOpen && (node.children ?? []).map((child) => (
                <TreeNode
                    key={child.key} node={child} depth={depth + 1} expanded={expanded} toggle={toggle}
                    selectedId={selectedId} onSelect={onSelect} onDragStart={onDragStart} onDrop={onDrop}
                    dropTarget={dropTarget} setDropTarget={setDropTarget} onAddChild={onAddChild} onToggleSpawn={onToggleSpawn}
                />
            ))}
        </div>
    );
}

function EntryFields({ asset, draft, updateDraft, updateData, scenes, assets, ensureReference, onImportTavern, onExportQuickReplies }) {
    const isScene = asset.kind === 'scene';
    const contains = {
        children: isScene ? scenes.filter((scene) => scene.data?.parentKey === asset.data?.key) : [],
        npcs: assets.filter((entry) => entry.kind === 'npc' && entry.data?.locationKey === asset.data?.key),
        events: assets.filter((entry) => entry.kind === 'event' && entry.data?.sceneKey === asset.data?.key),
        quests: assets.filter((entry) => entry.kind === 'quest' && (entry.data?.start?.locationKey === asset.data?.key || entry.data?.turnIn?.npcKey === asset.data?.key)),
    };
    return (
        <div className="strpg-workbench-form">
            <div className="strpg-workbench-form-grid">
                <Field label="Name"><Input value={draft.name ?? ''} onChange={(event) => updateDraft('name', event.target.value)} /></Field>
                <Field label="Key" hint="Immutable once created"><Input value={draft.key ?? ''} disabled /></Field>
                <Field label="Tags" hint="Comma-separated"><Input value={draft.tagsText ?? ''} onChange={(event) => updateDraft('tagsText', event.target.value)} /></Field>
                <Field label="Status"><Input value={asset.status} disabled /></Field>
            </div>
            <Field label="Description"><Textarea rows={5} value={draft.description ?? ''} onChange={(event) => updateData('description', event.target.value)} /></Field>
            {isScene && (
                <div className="strpg-workbench-form-grid">
                    <Field label="Layer">
                        <Select value={draft.layer ?? 'region'} onChange={(event) => updateData('layer', event.target.value)}>
                            {LAYERS.map((layer) => <option key={layer} value={layer}>{layer}</option>)}
                        </Select>
                    </Field>
                    <Field label="Display Type"><Input value={draft.type ?? ''} onChange={(event) => updateData('type', event.target.value)} /></Field>
                    <Field label="Site Type" hint="Only wilderness and dungeon can roll random encounters.">
                        <Select value={draft.siteType ?? inferSiteType(draft)} onChange={(event) => updateData('siteType', event.target.value)}>
                            <option value="indoor">indoor</option><option value="town">town</option><option value="wilderness">wilderness</option><option value="dungeon">dungeon</option>
                        </Select>
                    </Field>
                    <Field label="Spawn point">
                        <Select value={draft.isSpawn ? 'yes' : 'no'} onChange={(event) => updateData('isSpawn', event.target.value === 'yes')}>
                            <option value="no">no</option><option value="yes">yes</option>
                        </Select>
                    </Field>
                    <Field label="Parent Scene">
                        <Select value={draft.parentKey ?? ''} onChange={(event) => updateData('parentKey', event.target.value || null)}>
                            <option value="">No parent</option>
                            {scenes.filter((scene) => scene.id !== asset.id).map((scene) => <option key={scene.id} value={scene.data?.key}>{scene.data?.name} · {scene.data?.key}</option>)}
                        </Select>
                    </Field>
                    <Field label="Map X"><Input type="number" value={draft.map?.x ?? 0} onChange={(event) => updateData('map', { ...draft.map, x: Number(event.target.value) })} /></Field>
                    <Field label="Map Y"><Input type="number" value={draft.map?.y ?? 0} onChange={(event) => updateData('map', { ...draft.map, y: Number(event.target.value) })} /></Field>
                </div>
            )}
            {asset.kind === 'npc' && (
                <Field label="Location">
                    <Select value={draft.locationKey ?? ''} onChange={(event) => updateData('locationKey', event.target.value)}>
                        <option value="">Unassigned</option>
                        {scenes.map((scene) => <option key={scene.id} value={scene.data?.key}>{scene.data?.name} · {scene.data?.key}</option>)}
                    </Select>
                </Field>
            )}
            {asset.kind === 'event' && (
                <div className="strpg-workbench-form-grid">
                    <Field label="Scope">
                        <Select value={draft.scope ?? 'scene'} onChange={(event) => updateData('scope', event.target.value)}>
                            <option value="scene">scene</option><option value="world">world</option><option value="story">story</option>
                        </Select>
                    </Field>
                    <Field label="Scene">
                        <Select value={draft.sceneKey ?? ''} onChange={(event) => updateData('sceneKey', event.target.value || null)}>
                            <option value="">None</option>
                            {scenes.map((scene) => <option key={scene.id} value={scene.data?.key}>{scene.data?.name} · {scene.data?.key}</option>)}
                        </Select>
                    </Field>
                    <Field label="Trigger">
                        <Select value={draft.trigger ?? 'enter'} onChange={(event) => updateData('trigger', event.target.value)}>
                            {['enter', 'interact', 'flag', 'quest', 'combat_victory', 'manual'].map((value) => <option key={value} value={value}>{value}</option>)}
                        </Select>
                    </Field>
                </div>
            )}
            {asset.kind === 'quest' && (
                <div className="strpg-workbench-form-grid">
                    <Field label="Type">
                        <Select value={draft.type ?? 'side'} onChange={(event) => updateData('type', event.target.value)}>
                            <option value="main">main</option><option value="side">side</option><option value="hidden">hidden</option>
                        </Select>
                    </Field>
                    <Field label="Level"><Input type="number" value={draft.level ?? 1} onChange={(event) => updateData('level', Number(event.target.value))} /></Field>
                </div>
            )}

            {asset.kind === 'npc' && (
                <div className="strpg-workbench-section">
                    <div className="strpg-row between">
                        <span className="strpg-eyebrow">TAVERN CHARACTER</span>
                        <div className="strpg-row">
                            <Select value={draft.important ? 'yes' : 'no'} onChange={(event) => updateData('important', event.target.value === 'yes')}>
                                <option value="no">not important</option><option value="yes">important NPC</option>
                            </Select>
                            {draft.important && <Button size="sm" variant="gold" onClick={() => onImportTavern?.()}>Import to Tavern</Button>}
                            <Button size="sm" variant="ghost" onClick={() => onExportQuickReplies?.()}>Quick Replies</Button>
                        </div>
                    </div>
                    {draft.tavern?.avatar && <span className="strpg-muted">Imported as {draft.tavern.avatar}</span>}
                    <div className="strpg-row between"><span className="strpg-eyebrow">FUNCTIONS</span><Button size="sm" onClick={() => updateData('interactions', [...(draft.interactions ?? []), { key: `interaction_${Date.now().toString(36).slice(-4)}`, label: 'Talk', type: 'talk', description: '', actions: [] }])}>Add function</Button></div>
                    {(draft.interactions ?? []).map((interaction, index) => (
                        <div className="strpg-reference-row" key={interaction.key}>
                            <Input value={interaction.label ?? ''} placeholder="Label" onChange={(event) => updateData('interactions', (draft.interactions ?? []).map((entry, i) => i === index ? { ...entry, label: event.target.value } : entry))} />
                            <Select value={interaction.type ?? 'talk'} onChange={(event) => updateData('interactions', (draft.interactions ?? []).map((entry, i) => i === index ? { ...entry, type: event.target.value } : entry))}>
                                {['talk', 'shop', 'accept_quest', 'turn_in_quest', 'join_party', 'heal', 'story', 'custom'].map((type) => <option key={type} value={type}>{type}</option>)}
                            </Select>
                            {(interaction.type === 'accept_quest' || interaction.type === 'turn_in_quest' || interaction.type === 'story') && (
                                <Input value={interaction.questKey ?? ''} placeholder="Quest / story key" onChange={(event) => updateData('interactions', (draft.interactions ?? []).map((entry, i) => i === index ? { ...entry, questKey: event.target.value } : entry))} />
                            )}
                            <Button size="sm" variant="ghost" onClick={() => updateData('interactions', (draft.interactions ?? []).filter((_, i) => i !== index))}>×</Button>
                        </div>
                    ))}
                    <div className="strpg-row between"><span className="strpg-eyebrow">SHOP</span>{!draft.shop && <Button size="sm" onClick={() => updateData('shop', { buyRate: 1, sellRate: 0.5, items: [] })}>Add shop</Button>}</div>
                    {draft.shop && (
                        <>
                            {(draft.shop.items ?? []).map((item, index) => (
                                <div className="strpg-reference-row" key={index}>
                                    <Input value={item.itemKey ?? ''} placeholder="item key" onChange={(event) => updateData('shop', { ...draft.shop, items: draft.shop.items.map((entry, i) => i === index ? { ...entry, itemKey: event.target.value } : entry) })} />
                                    <Input type="number" value={item.price ?? 0} placeholder="price" onChange={(event) => updateData('shop', { ...draft.shop, items: draft.shop.items.map((entry, i) => i === index ? { ...entry, price: Number(event.target.value) } : entry) })} />
                                    <Input type="number" value={item.stock ?? 0} placeholder="stock" onChange={(event) => updateData('shop', { ...draft.shop, items: draft.shop.items.map((entry, i) => i === index ? { ...entry, stock: Number(event.target.value) } : entry) })} />
                                    <Button size="sm" variant="ghost" onClick={() => ensureReference?.('equipment', item.itemKey, item.itemKey)}>Ensure item</Button>
                                    <Button size="sm" variant="ghost" onClick={() => updateData('shop', { ...draft.shop, items: draft.shop.items.filter((_, i) => i !== index) })}>×</Button>
                                </div>
                            ))}
                            <Button size="sm" variant="ghost" onClick={() => updateData('shop', { ...draft.shop, items: [...(draft.shop.items ?? []), { itemKey: '', price: 0, stock: null }] })}>Add shop item</Button>
                        </>
                    )}
                </div>
            )}
            {asset.kind === 'monster' && (
                <div className="strpg-workbench-section">
                    <div className="strpg-workbench-form-grid">
                        <Field label="Level"><Input type="number" value={draft.level ?? 1} onChange={(event) => updateData('level', Number(event.target.value))} /></Field>
                        <Field label="Max HP"><Input type="number" value={draft.stats?.maxHp ?? 50} onChange={(event) => updateData('stats', { ...draft.stats, maxHp: Number(event.target.value) })} /></Field>
                        <Field label="Attack"><Input type="number" value={draft.stats?.atk ?? 8} onChange={(event) => updateData('stats', { ...draft.stats, atk: Number(event.target.value) })} /></Field>
                        <Field label="Defense"><Input type="number" value={draft.stats?.def ?? 4} onChange={(event) => updateData('stats', { ...draft.stats, def: Number(event.target.value) })} /></Field>
                        <Field label="EXP"><Input type="number" value={draft.exp ?? 10} onChange={(event) => updateData('exp', Number(event.target.value))} /></Field>
                        <Field label="Gold"><Input type="number" value={draft.gold ?? 5} onChange={(event) => updateData('gold', Number(event.target.value))} /></Field>
                    </div>
                    <span className="strpg-eyebrow">DROPS</span>
                    {(draft.drops ?? []).map((drop, index) => (
                        <div className="strpg-reference-row" key={index}>
                            <Input value={drop.itemKey ?? ''} placeholder="item key" onChange={(event) => updateData('drops', (draft.drops ?? []).map((entry, i) => i === index ? { ...entry, itemKey: event.target.value } : entry))} />
                            <Input type="number" step="0.05" value={drop.chance ?? 0.5} placeholder="chance" onChange={(event) => updateData('drops', (draft.drops ?? []).map((entry, i) => i === index ? { ...entry, chance: Number(event.target.value) } : entry))} />
                            <Input type="number" value={drop.min ?? 1} placeholder="min" onChange={(event) => updateData('drops', (draft.drops ?? []).map((entry, i) => i === index ? { ...entry, min: Number(event.target.value) } : entry))} />
                            <Input type="number" value={drop.max ?? 1} placeholder="max" onChange={(event) => updateData('drops', (draft.drops ?? []).map((entry, i) => i === index ? { ...entry, max: Number(event.target.value) } : entry))} />
                            <Button size="sm" variant="ghost" onClick={() => ensureReference?.('equipment', drop.itemKey, drop.itemKey)}>Ensure item</Button>
                            <Button size="sm" variant="ghost" onClick={() => updateData('drops', (draft.drops ?? []).filter((_, i) => i !== index))}>×</Button>
                        </div>
                    ))}
                    <Button size="sm" variant="ghost" onClick={() => updateData('drops', [...(draft.drops ?? []), { itemKey: '', chance: 0.5, min: 1, max: 1 }])}>Add drop</Button>
                </div>
            )}
            {asset.kind === 'equipment' && (
                <div className="strpg-workbench-form-grid">
                    <Field label="Item kind"><Select value={draft.kind ?? 'weapon'} onChange={(event) => updateData('kind', event.target.value)}>{['weapon', 'armor', 'accessory', 'consumable', 'quest', 'material'].map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
                    <Field label="Slot"><Select value={draft.slot ?? ''} onChange={(event) => updateData('slot', event.target.value || null)}><option value="">none</option><option value="weapon">weapon</option><option value="armor">armor</option><option value="accessory">accessory</option></Select></Field>
                    <Field label="Price"><Input type="number" value={draft.price ?? 0} onChange={(event) => updateData('price', Number(event.target.value))} /></Field>
                    <Field label="Rarity"><Input value={draft.rarity ?? 'common'} onChange={(event) => updateData('rarity', event.target.value)} /></Field>
                </div>
            )}
            {asset.kind === 'skill' && (
                <div className="strpg-workbench-form-grid">
                    <Field label="Category"><Select value={draft.category ?? 'active'} onChange={(event) => updateData('category', event.target.value)}><option value="active">active</option><option value="passive">passive</option></Select></Field>
                    <Field label="Skill type"><Select value={draft.type ?? 'attack'} onChange={(event) => updateData('type', event.target.value)}>{['attack', 'heal', 'buff', 'debuff', 'status', 'utility'].map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
                    <Field label="MP cost"><Input type="number" value={draft.mpCost ?? 0} onChange={(event) => updateData('mpCost', Number(event.target.value))} /></Field>
                    <Field label="Cooldown"><Input type="number" value={draft.cooldown ?? 0} onChange={(event) => updateData('cooldown', Number(event.target.value))} /></Field>
                </div>
            )}
            {asset.kind === 'status_effect' && (
                <div className="strpg-workbench-form-grid">
                    <Field label="Effect kind"><Select value={draft.kind ?? 'debuff'} onChange={(event) => updateData('kind', event.target.value)}>{['buff', 'debuff', 'dot', 'control'].map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
                    <Field label="Duration"><Input type="number" value={draft.duration ?? 2} onChange={(event) => updateData('duration', Number(event.target.value))} /></Field>
                </div>
            )}

            {isScene && (
                <div className="strpg-workbench-section">
                    <div className="strpg-row between"><span className="strpg-eyebrow">ENCOUNTERS</span><Button size="sm" onClick={() => updateData('encounters', [...(draft.encounters ?? []), { key: `encounter_${Date.now().toString(36).slice(-4)}`, name: 'New Encounter', respawnSeconds: 90, monsters: [] }])}>Add fixed encounter</Button></div>
                    {(draft.encounters ?? []).map((encounter, encounterIndex) => (
                        <div className="strpg-encounter-block" key={encounter.key ?? encounterIndex}>
                            <div className="strpg-reference-row">
                                <Input value={encounter.name ?? ''} placeholder="Encounter name" onChange={(event) => updateData('encounters', (draft.encounters ?? []).map((entry, i) => i === encounterIndex ? { ...entry, name: event.target.value } : entry))} />
                                <Input value={encounter.key ?? ''} placeholder="key" onChange={(event) => updateData('encounters', (draft.encounters ?? []).map((entry, i) => i === encounterIndex ? { ...entry, key: event.target.value } : entry))} />
                                <Button size="sm" variant="ghost" onClick={() => updateData('encounters', (draft.encounters ?? []).filter((_, i) => i !== encounterIndex))}>×</Button>
                            </div>
                            {(encounter.monsters ?? []).map((monster, monsterIndex) => (
                                <div className="strpg-reference-row" key={monsterIndex}>
                                    <Input value={monster.monsterKey ?? ''} placeholder="monster key" onChange={(event) => updateData('encounters', (draft.encounters ?? []).map((entry, i) => i === encounterIndex ? { ...entry, monsters: entry.monsters.map((m, j) => j === monsterIndex ? { ...m, monsterKey: event.target.value } : m) } : entry))} />
                                    <Input type="number" value={monster.count ?? 1} placeholder="count" onChange={(event) => updateData('encounters', (draft.encounters ?? []).map((entry, i) => i === encounterIndex ? { ...entry, monsters: entry.monsters.map((m, j) => j === monsterIndex ? { ...m, count: Number(event.target.value) } : m) } : entry))} />
                                    <Button size="sm" variant="ghost" onClick={() => ensureReference?.('monster', monster.monsterKey, monster.monsterKey)}>Ensure monster</Button>
                                    <Button size="sm" variant="ghost" onClick={() => updateData('encounters', (draft.encounters ?? []).map((entry, i) => i === encounterIndex ? { ...entry, monsters: entry.monsters.filter((_, j) => j !== monsterIndex) } : entry))}>×</Button>
                                </div>
                            ))}
                            <Button size="sm" variant="ghost" onClick={() => updateData('encounters', (draft.encounters ?? []).map((entry, i) => i === encounterIndex ? { ...entry, monsters: [...(entry.monsters ?? []), { monsterKey: '', count: 1 }] } : entry))}>Add monster</Button>
                        </div>
                    ))}
                    <div className="strpg-row between">
                        <span className="strpg-eyebrow">RANDOM ENCOUNTER</span>
                        <Select value={draft.randomEncounter?.enabled ? 'on' : 'off'} onChange={(event) => updateData('randomEncounter', { ...(draft.randomEncounter ?? { name: 'Random Encounter', chance: 0.35, dice: { count: 2, sides: 6 }, difficulty: 8, cooldownSeconds: 90, monsters: [] }), enabled: event.target.value === 'on' })}>
                            <option value="off">off</option><option value="on">on</option>
                        </Select>
                    </div>
                    {draft.randomEncounter?.enabled && (
                        <>
                            <div className="strpg-reference-row">
                                <Input value={draft.randomEncounter.name ?? ''} placeholder="name" onChange={(event) => updateData('randomEncounter', { ...draft.randomEncounter, name: event.target.value })} />
                                <Input type="number" step="0.01" value={draft.randomEncounter.chance ?? 0.35} placeholder="chance" onChange={(event) => updateData('randomEncounter', { ...draft.randomEncounter, chance: Number(event.target.value) })} />
                                <Input type="number" value={draft.randomEncounter.dice?.sides ?? 6} placeholder="sides" onChange={(event) => updateData('randomEncounter', { ...draft.randomEncounter, dice: { ...(draft.randomEncounter.dice ?? {}), sides: Number(event.target.value) } })} />
                                <Input type="number" value={draft.randomEncounter.difficulty ?? 8} placeholder="difficulty" onChange={(event) => updateData('randomEncounter', { ...draft.randomEncounter, difficulty: Number(event.target.value) })} />
                            </div>
                            {(draft.randomEncounter.monsters ?? []).map((monster, index) => (
                                <div className="strpg-reference-row" key={index}>
                                    <Input value={monster.monsterKey ?? ''} placeholder="monster key" onChange={(event) => updateData('randomEncounter', { ...draft.randomEncounter, monsters: draft.randomEncounter.monsters.map((m, i) => i === index ? { ...m, monsterKey: event.target.value } : m) })} />
                                    <Input type="number" value={monster.count ?? 1} placeholder="count" onChange={(event) => updateData('randomEncounter', { ...draft.randomEncounter, monsters: draft.randomEncounter.monsters.map((m, i) => i === index ? { ...m, count: Number(event.target.value) } : m) })} />
                                    <Button size="sm" variant="ghost" onClick={() => ensureReference?.('monster', monster.monsterKey, monster.monsterKey)}>Ensure monster</Button>
                                    <Button size="sm" variant="ghost" onClick={() => updateData('randomEncounter', { ...draft.randomEncounter, monsters: draft.randomEncounter.monsters.filter((_, i) => i !== index) })}>×</Button>
                                </div>
                            ))}
                            <Button size="sm" variant="ghost" onClick={() => updateData('randomEncounter', { ...draft.randomEncounter, monsters: [...(draft.randomEncounter.monsters ?? []), { monsterKey: '', count: 1 }] })}>Add random monster</Button>
                        </>
                    )}
                </div>
            )}
            {isScene && (
                <div className="strpg-workbench-contents">
                    <span className="strpg-eyebrow">CONTAINS</span>
                    <div className="strpg-row wrap">
                        <Badge>{contains.children.length} child scenes</Badge>
                        <Badge>{contains.npcs.length} NPCs</Badge>
                        <Badge>{contains.events.length} events</Badge>
                        <Badge>{contains.quests.length} quests</Badge>
                        <Badge>{draft.encounters?.length ?? 0} fixed encounters</Badge>
                        <Badge>{draft.randomEncounter?.enabled ? 'random encounter' : 'no random encounter'}</Badge>
                    </div>
                    <div className="strpg-muted">
                        {[...contains.children, ...contains.npcs, ...contains.events, ...contains.quests].map((entry) => entry.data?.name ?? entry.name).join(' · ') || 'No linked entries yet.'}
                    </div>
                </div>
            )}
        </div>
    );
}

function SceneGraph({ scenes, selectedId, connectMode, connectSource, disconnectMode, onToggleConnect, onToggleDisconnect, onDisconnect, onNodeClick }) {
    const width = 1000;
    const height = 560;
    const positions = new Map();
    scenes.forEach((scene, index) => {
        positions.set(scene.id, {
            x: Number(scene.data?.map?.x ?? 120 + (index % 4) * 220),
            y: Number(scene.data?.map?.y ?? 100 + Math.floor(index / 4) * 150),
        });
    });
    const renderedEdges = [];
    const seenPairs = new Set();
    for (const scene of scenes) {
        for (const connection of scene.data?.connections ?? []) {
            const target = scenes.find((entry) => entry.data?.key === connection.toKey);
            if (!target) continue;
            const pair = [scene.data?.key, target.data?.key].sort().join('|');
            if (seenPairs.has(pair)) continue;
            seenPairs.add(pair);
            const reverse = (target.data?.connections ?? []).some((entry) => entry.toKey === scene.data?.key);
            renderedEdges.push({ from: scene, to: target, connection, bidirectional: Boolean(connection.bidirectional || reverse) });
        }
    }
    return (
        <div className="strpg-workbench-graph">
            <div className="strpg-graph-toolbar">
                <Button size="sm" variant={connectMode ? 'gold' : 'ghost'} onClick={onToggleConnect}>{connectMode ? 'Connecting…' : 'Connect Scenes'}</Button>
                <Button size="sm" variant={disconnectMode ? 'danger' : 'ghost'} onClick={onToggleDisconnect}>{disconnectMode ? 'Removing…' : 'Disconnect'}</Button>
                <span className="strpg-muted">{connectMode ? (connectSource ? `Source: ${connectSource.name} — click target` : 'Click source scene') : 'Click a scene to edit; Connect creates a scene transition.'}</span>
                <span className="strpg-graph-legend"><i className="oneway" /> one-way <i className="bidirectional" /> bidirectional</span>
            </div>
            <svg viewBox={`0 0 ${width} ${height}`} className="strpg-workbench-svg">
                {renderedEdges.map(({ from, to, connection, bidirectional }) => {
                    const a = positions.get(from.id);
                    const b = positions.get(to.id);
                    return (
                        <g key={`${from.id}:${to.id}`}>
                            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={bidirectional ? '#58a6a6' : '#e0b85c'} strokeWidth={bidirectional ? 2 : 1.4} style={{ cursor: disconnectMode ? 'crosshair' : 'pointer' }} onClick={() => { if (disconnectMode) onDisconnect(from, to); }} />
                            <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} className="strpg-workbench-edge">{connection.mode ?? 'walk'}{connection.travelCost ? ` · ${connection.travelCost}G` : ''}</text>
                        </g>
                    );
                })}
                {scenes.map((scene) => {
                    const point = positions.get(scene.id);
                    const source = connectSource?.id === scene.id;
                    return (
                        <g key={scene.id} transform={`translate(${point.x},${point.y})`} onClick={() => onNodeClick(scene)} className="strpg-workbench-node">
                            <circle r={source ? 27 : 22} fill="#0c1420" stroke={source ? '#e0b85c' : selectedId === scene.id ? '#ffffff' : '#6d8297'} strokeWidth={source || selectedId === scene.id ? 3 : 1.5} />
                            <text y={40} textAnchor="middle" className="strpg-workbench-node-label">{scene.data?.name ?? scene.name}</text>
                            <text y={53} textAnchor="middle" className="strpg-workbench-node-sub">{scene.data?.layer ?? 'region'}</text>
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}

function ConnectionModal({ value, setValue, onClose, onSave }) {
    if (!value) return null;
    const modes = ['road', 'trail', 'walk', 'door', 'stairs', 'gate', 'portal', 'secret'];
    return (
        <Modal
            open
            title={`Connect ${value.source.data?.name} → ${value.target.data?.name}`}
            subtitle="Connection is stored on the source scene. Bidirectional creates the reverse route at build."
            onClose={onClose}
            footer={<><Button onClick={onClose}>Cancel</Button><Button variant="gold" onClick={onSave}>Create Connection</Button></>}
        >
            <div className="strpg-workbench-form-grid">
                <Field label="Mode">
                    <Select value={value.mode} onChange={(event) => setValue({ ...value, mode: event.target.value })}>
                        {modes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                    </Select>
                </Field>
                <Field label="Travel cost"><Input type="number" value={value.cost} onChange={(event) => setValue({ ...value, cost: Number(event.target.value) })} /></Field>
                <Field label="Bidirectional">
                    <Select value={value.bidirectional ? 'yes' : 'no'} onChange={(event) => setValue({ ...value, bidirectional: event.target.value === 'yes' })}>
                        <option value="yes">yes</option><option value="no">no</option>
                    </Select>
                </Field>
            </div>
        </Modal>
    );
}

function ImageImportModal({ open, assets, onClose, onRefresh, notify }) {
    const inputRef = useRef(null);
    const [busy, setBusy] = useState(false);
    const [report, setReport] = useState(null);
    if (!open) return null;

    const parseName = (filename) => {
        const base = filename.replace(/\.[^.]+$/, '');
        const tokens = base.split('_');
        const kind = IMAGE_KINDS[(tokens.shift() ?? '').toLowerCase()] ?? null;
        let status = null;
        const last = tokens[tokens.length - 1];
        if (tokens.length > 1 && (/^(lv)?\d+$/i.test(last) || STATUS_WORDS.has(last.toLowerCase()))) {
            status = tokens.pop();
        }
        return { kind, name: tokens.join('_'), status };
    };

    const run = async (files) => {
        setBusy(true);
        const results = [];
        for (const file of files) {
            const parsed = parseName(file.name);
            if (!parsed.kind || !parsed.name) {
                results.push({ file: file.name, status: 'skipped', reason: 'Unsupported category or empty name' });
                continue;
            }
            const asset = assets.find((entry) => entry.kind === parsed.kind && (slug(entry.asset_key) === slug(parsed.name) || slug(entry.data?.name) === slug(parsed.name)));
            if (!asset) {
                results.push({ file: file.name, status: 'skipped', reason: `No matching ${parsed.kind} for '${parsed.name}'` });
                continue;
            }
            try {
                const dataUrl = await fileToDataUrl(file);
                const field = asset.kind === 'npc' ? 'portrait' : 'image';
                const data = { ...asset.data, [field]: dataUrl };
                if (parsed.status) {
                    data.imageStatus = parsed.status;
                    if (/^\d+$/.test(parsed.status)) data.imageLevel = Number(parsed.status);
                }
                const saved = await saveAsset(asset, data, asset.name);
                results.push({ file: file.name, status: 'imported', asset: asset.asset_key, draft: saved.id });
            } catch (error) {
                results.push({ file: file.name, status: 'error', reason: error.message });
            }
        }
        setReport(results);
        await onRefresh?.();
        notify?.(`Image import finished: ${results.filter((entry) => entry.status === 'imported').length} imported.`, 'success');
        setBusy(false);
    };

    return (
        <Modal
            open
            title="Batch Image Import"
            subtitle="Folder filenames: category_name_status-or-level.ext. Example: npc_elder_mira_3.png"
            onClose={onClose}
            wide
            footer={<><Button onClick={onClose}>Close</Button><Button variant="gold" onClick={() => inputRef.current?.click()} disabled={busy}>{busy ? 'Importing...' : 'Choose Image Folder'}</Button></>}
        >
            <input ref={inputRef} type="file" accept="image/*" multiple webkitdirectory="" style={{ display: 'none' }} onChange={(event) => run([...event.target.files])} />
            <div className="strpg-image-import">
                <p className="strpg-muted">Supported categories: npc, scene, event, quest, item, skill, monster, class, world, rules, effect, story. A numeric or status suffix is recorded as image level/status.</p>
                {report && (
                    <div className="strpg-image-report">
                        {report.map((entry) => (
                            <div key={entry.file} className={`strpg-image-row ${entry.status}`}>
                                <strong>{entry.file}</strong>
                                <span>{entry.status}{entry.reason ? ` · ${entry.reason}` : ''}{entry.asset ? ` · ${entry.asset}` : ''}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </Modal>
    );
}




function QuickEntryModal({ open, projectId, onClose, onRefresh, onSaved, notify }) {
    const [mode, setMode] = useState('scene');
    const [prompt, setPrompt] = useState(QUICK_MODES.scene.prompt);
    const [text, setText] = useState(QUICK_MODES.scene.template);
    const [busy, setBusy] = useState(false);
    if (!open) return null;
    const parse = () => {
        const fields = {};
        const notes = [];
        for (const line of text.split(/\r?\n/)) {
            const match = line.match(/^([A-Za-z ]+):\s*(.*)$/);
            if (!match) {
                if (line.trim()) notes.push(line.trim());
                continue;
            }
            fields[match[1].trim().toLowerCase()] = match[2].trim();
        }
        const type = (fields.type ?? QUICK_MODES[mode]?.type ?? 'scene').toLowerCase();
        const kind = IMAGE_KINDS[type] ?? (['region', 'town', 'dungeon', 'building', 'room'].includes(type) ? 'scene' : 'scene');
        const name = fields.name || fields.key || 'New Entry';
        const key = fields.key || slug(name);
        const data = { key, name, description: fields.description || notes.join(' ') || '', tags: (fields.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean), designerNotes: notes };
        if (kind === 'scene') {
            const typeLayers = { town: 'settlement', city: 'settlement', village: 'settlement', shop: 'interior', inn: 'interior', temple: 'interior', room: 'room', dungeon: 'dungeon', floor: 'floor' };
            data.type = type === 'scene' ? 'region' : type;
            data.layer = fields.layer || typeLayers[type] || 'region';
            data.parentKey = fields.parent || null;
            data.map = { x: 200, y: 200 };
            data.connections = [];
            data.spawnPoints = [];
        } else if (kind === 'npc') {
            data.locationKey = fields.parent || fields.location || 'REPLACE_WITH_LOCATION';
            data.interactions = [];
            data.shop = null;
            data.questsOffered = [];
            data.joinable = false;
        } else if (kind === 'event') {
            data.scope = 'scene';
            data.sceneKey = fields.parent || fields.scene || 'REPLACE_WITH_SCENE';
            data.trigger = 'enter';
            data.condition = {};
            data.actions = [];
        }
        return { kind, data, name };
    };

    const expand = async () => {
        setBusy(true);
        try {
            const ctx = globalThis.SillyTavern?.getContext?.();
            if (!ctx?.generateQuietPrompt) throw new Error('SillyTavern generateQuietPrompt is not available in this context');
            const system = `You are the STRPG World Writer. Expand the user prompt into ONE human-readable ${QUICK_MODES[mode]?.label ?? 'entry'}. Do not output JSON. Use exactly these labels when possible: Type, Key, Name, Parent, Layer, Tags, Description. The requested Type is ${QUICK_MODES[mode]?.type ?? 'scene'}. Type must be one of scene, npc, event, quest, item, skill, monster, class, rules. Layer is world, region, settlement, interior, room, dungeon, floor. Parent is a scene/location key or empty. Keep prose vivid but concise. Do not invent monsters, items, quests or mechanics that were not requested; put uncertainties in a Notes line.`;
            const reply = await ctx.generateQuietPrompt({ quietPrompt: `${system}\n\nUSER REQUEST:\n${prompt}\n\nOutput only the entry text.`, responseLength: 1400 });
            setText(String(reply ?? '').trim());
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };

    const submit = async () => {
        setBusy(true);
        try {
            const parsed = parse();
            const created = await api(`/projects/${projectId}/assets`, { method: 'POST', body: parsed });
            notify?.('Entry imported as DRAFT. Review the parsed fields before publishing.', 'success');
            await onRefresh?.();
            onSaved?.(created);
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };
    return (
        <Modal
            open
            title="Import Human Entry"
            subtitle="Paste a readable entry. Known labels become fields; unlabeled lines go to designerNotes."
            onClose={onClose}
            wide
            footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="gold" onClick={submit} disabled={busy}>{busy ? 'Importing...' : 'Parse and Create DRAFT'}</Button></>}
        >
            <Field label="Generate" hint="Select the asset type first; this changes both the template and the World Writer prompt.">
                <Select value={mode} onChange={(event) => { const next = event.target.value; setMode(next); setPrompt(QUICK_MODES[next].prompt); setText(QUICK_MODES[next].template); }}>
                    {Object.entries(QUICK_MODES).map(([value, option]) => <option key={value} value={value}>{option.label}</option>)}
                </Select>
            </Field>
            <Field label="Designer prompt" hint="The World Writer expands this into an Entry Card; it does not touch the database.">
                <Textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            </Field>
            <div className="strpg-row"><Button onClick={expand} disabled={busy}>Expand with LLM</Button></div>
            <Field label="Entry text" hint="Type / Key / Name / Parent / Layer / Tags / Description">
                <Textarea rows={18} value={text} onChange={(event) => setText(event.target.value)} />
            </Field>
        </Modal>
    );
}

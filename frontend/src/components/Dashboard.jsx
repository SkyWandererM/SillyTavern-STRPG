import React, { useCallback, useEffect, useState } from 'react';
import { api, randomIdempotencyKey } from '../api.js';
import {
    Badge, Bar, Button, Empty, ErrorBox, Field, Input, Loading, Modal, ProgressDots, SectionTitle, Select, StatusBadge,
} from '../ui.jsx';
import { NpcModal, ShopModal } from './Characters.jsx';

const EVENT_LABELS = {
    'campaign.created': 'Campaign created',
    'player.moved': 'Travelled',
    'quest.accepted': 'Quest accepted',
    'quest.completed': 'Quest completed',
    'quest.turned_in': 'Quest turned in',
    'quest.failed': 'Quest failed',
    'quest.stage': 'Quest stage advanced',
    'quest.objective': 'Objective progress',
    'combat.started': 'Combat started',
    'combat.proposed': 'Encounter proposed',
    'combat.ended': 'Combat ended',
    'combat.victory': 'Victory',
    'combat.defeat': 'Defeat',
    'combat.fled': 'Fled from combat',
    'story.advanced': 'Story advanced',
    'story.entered': 'Entered story beat',
    'story.ending': 'Ending reached',
    'item.acquired': 'Item acquired',
    'item.equipped': 'Item equipped',
    'entity.joined_party': 'Companion joined',
    'entity.level_up': 'Level up',
    'npc.interaction': 'Talked with someone',
    'campaign.upgraded': 'Campaign upgraded',
    'encounter.respawn_scheduled': 'Encounter respawn',
};

function eventLabel(event) {
    const base = EVENT_LABELS[event.type] ?? String(event.type ?? 'event').replace(/[._]/g, ' ');
    const detail = event.payload?.name ?? event.payload?.questName ?? event.payload?.title ?? event.payload?.encounterKey ?? event.payload?.location ?? '';
    return detail ? `${base} · ${detail}` : base;
}

function portraitOf(entity) {
    return entity?.portrait ?? entity?.data?.portrait ?? null;
}

function Avatar({ entity, size = 'md' }) {
    const portrait = portraitOf(entity);
    return (
        <span className={`strpg-game-avatar ${size}`}>
            {portrait ? <img src={portrait} alt="" /> : String(entity?.name ?? '?').slice(0, 1)}
        </span>
    );
}

function VitalsCard({ dashboard, setTab }) {
    const player = dashboard.player;
    return (
        <section className="strpg-game-card vitals">
            <header className="strpg-game-card-head">
                <div>
                    <span className="strpg-eyebrow">ADVENTURER</span>
                    <h3>{player.name}</h3>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setTab('characters')}>Sheet ›</Button>
            </header>
            <div className="strpg-game-vitals">
                <Avatar entity={player} size="lg" />
                <div className="strpg-game-vitals-main">
                    <div className="strpg-game-vitals-meta">
                        <Badge tone="gold">Lv.{player.level}</Badge>
                        <span>{player.data?.classKey ?? 'adventurer'}</span>
                        <Badge tone="info">{dashboard.inventory?.gold ?? player.gold} G</Badge>
                    </div>
                    <Bar label="HP" value={player.hp} max={player.stats.maxHp} tone="hp" />
                    <Bar label="MP" value={player.mp} max={player.stats.maxMp} tone="mp" />
                    <Bar label="EXP" value={player.xp} max={player.xpToNext} tone="xp" />
                </div>
            </div>
            {dashboard.effects?.length > 0 && (
                <div className="strpg-game-effects">
                    {dashboard.effects.map((effect) => (
                        <span key={effect.key} title={`${effect.duration} turn(s)`}>{effect.name}{effect.stacks > 1 ? ` ×${effect.stacks}` : ''}</span>
                    ))}
                </div>
            )}
            <div className="strpg-game-statline">
                {['atk', 'def', 'res', 'crit'].map((key) => (
                    <div key={key}><span>{key.toUpperCase()}</span><strong>{Math.round(player.stats[key] ?? 0)}</strong></div>
                ))}
            </div>
            <div className="strpg-game-equipment">
                {(player.equipment ?? []).slice(0, 4).map((entry) => (
                    <div key={entry.slot}><span>{entry.slot}</span><strong>{entry.name}</strong></div>
                ))}
                {!(player.equipment ?? []).length && <span className="strpg-muted">No equipment</span>}
            </div>
        </section>
    );
}

function PartyCard({ dashboard, setTab, onTalk }) {
    const party = dashboard.party ?? [];
    const nearby = dashboard.nearbyNpcs ?? [];
    return (
        <section className="strpg-game-card party">
            <header className="strpg-game-card-head">
                <div>
                    <span className="strpg-eyebrow">PARTY & PEOPLE</span>
                    <h3>{party.length + 1} in the party</h3>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setTab('characters')}>All ›</Button>
            </header>
            <div className="strpg-game-party">
                {party.map((member) => (
                    <div className="strpg-game-party-member" key={member.id}>
                        <Avatar entity={member} />
                        <div>
                            <strong>{member.name}</strong>
                            <span>Lv.{member.level} · {member.title || 'Companion'}</span>
                            <Bar label="HP" value={member.hp} max={member.maxHp} tone="hp" compact />
                        </div>
                    </div>
                ))}
                {!party.length && <p className="strpg-muted">No companions yet. Recruitable NPCs are marked in the People list.</p>}
            </div>
            <div className="strpg-game-subhead"><span>HERE NOW</span><span>{nearby.length}</span></div>
            <div className="strpg-game-nearby">
                {nearby.slice(0, 4).map((npc) => (
                    <button type="button" className="strpg-game-nearby-row" key={npc.id} onClick={() => onTalk?.(npc)} title={`Talk to ${npc.name}`}>
                        <Avatar entity={npc} size="sm" />
                        <div>
                            <strong>{npc.name}</strong>
                            <span>{npc.title || 'Local'}{npc.shop ? ' · merchant' : ''}{npc.joinable ? ' · recruitable' : ''}</span>
                        </div>
                        <Badge tone="neutral">{npc.relation > 0 ? `♥ ${npc.relation}` : 'Talk'}</Badge>
                    </button>
                ))}
                {!nearby.length && <span className="strpg-muted">Nobody is here right now.</span>}
            </div>
        </section>
    );
}

function LocationCard({ dashboard, campaignId, onMutated, notify, setTab, busy, setBusy }) {
    const location = dashboard.location;
    const exits = dashboard.exits ?? [];
    const travel = async (exit) => {
        if (!exit.available) {
            notify(exit.lockedReason === 'gold' ? 'Not enough gold for that route.' : 'That route is locked right now.', 'warning');
            return;
        }
        setBusy(`move:${exit.key}`);
        try {
            await api(`/campaigns/${campaignId}/move`, {
                method: 'POST',
                body: { location: exit.key, idempotencyKey: randomIdempotencyKey('move') },
            });
            notify(`Travelled to ${exit.name}.`, 'success');
            await onMutated?.();
        } catch (error) {
            notify(error.message, 'danger');
        } finally {
            setBusy(null);
        }
    };
    return (
        <section className="strpg-game-card location">
            <header className="strpg-game-card-head">
                <div>
                    <span className="strpg-eyebrow">LOCATION</span>
                    <h3>{location.name}</h3>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setTab('map')}>Map ›</Button>
            </header>
            <div className="strpg-game-location-meta">
                <Badge tone="gold">{location.region || location.layer || 'region'}</Badge>
                <Badge>{location.data?.siteType ?? location.type ?? 'scene'}</Badge>
                <Badge tone={location.discovered ? 'success' : 'neutral'}>{location.discovered ? 'Discovered' : 'Unknown'}</Badge>
            </div>
            <p className="strpg-game-location-desc">{location.description || 'No description written for this scene yet.'}</p>
            <div className="strpg-game-subhead"><span>ROUTES</span><span>{exits.length}</span></div>
            <div className="strpg-game-exits">
                {exits.map((exit) => (
                    <button type="button" key={exit.key} className={exit.available ? '' : 'locked'} disabled={Boolean(busy) || !exit.available} onClick={() => travel(exit)}>
                        <span>{exit.name}</span>
                        <small>{exit.lockedReason === 'gold' ? `Need ${exit.travelCost} G` : exit.lockedReason === 'condition' ? 'Locked' : `${exit.mode} · ${exit.travelCost} G`}</small>
                    </button>
                ))}
                {!exits.length && <span className="strpg-muted">No outgoing route. Edit connections in the Workbench.</span>}
            </div>
        </section>
    );
}

function QuestCard({ dashboard, setTab }) {
    const quests = dashboard.activeQuests ?? [];
    return (
        <section className="strpg-game-card quests">
            <header className="strpg-game-card-head">
                <div>
                    <span className="strpg-eyebrow">QUEST LOG</span>
                    <h3>{quests.length ? `${quests.length} active` : 'No active quest'}</h3>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setTab('quests')}>All ›</Button>
            </header>
            <div className="strpg-game-quest-list">
                {quests.slice(0, 4).map((quest) => {
                    const stage = (quest.stages ?? []).find((entry) => entry.key === quest.stageKey) ?? quest.stages?.[0];
                    return (
                        <div className="strpg-game-quest" key={quest.key}>
                            <div className="strpg-game-quest-head">
                                <Badge tone={quest.type === 'main' ? 'gold' : 'info'}>{quest.type}</Badge>
                                <strong>{quest.name}</strong>
                                {quest.status === 'ready_to_turn_in' && <Badge tone="gold">Turn in</Badge>}
                            </div>
                            <div className="strpg-game-quest-stage">
                                <span>{stage?.name ?? 'Stage'}</span>
                                {(stage?.objectives ?? []).slice(0, 3).map((objective) => (
                                    <div key={objective.key} className={objective.completed ? 'done' : ''}>
                                        <span>{objective.label || objective.key}</span>
                                        <ProgressDots value={objective.current} max={objective.count} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    );
                })}
                {!quests.length && <Empty title="Nothing tracked" icon="!">Accept a quest from a local NPC to fill the log.</Empty>}
            </div>
        </section>
    );
}

function CombatCard({ dashboard, openCombat }) {
    const combat = dashboard.combat;
    if (!combat) {
        return (
            <section className="strpg-game-card combat calm">
                <header className="strpg-game-card-head">
                    <div><span className="strpg-eyebrow">DANGER</span><h3>No hostile encounter</h3></div>
                    <Badge tone="success">Calm</Badge>
                </header>
                <p className="strpg-muted">Random encounters are rolled by the rules engine when you explore wilderness or dungeon scenes. Fixed encounters are listed on the scene.</p>
            </section>
        );
    }
    return (
        <section className={`strpg-game-card combat ${combat.status}`}>
            <header className="strpg-game-card-head">
                <div><span className="strpg-eyebrow">COMBAT · ROUND {combat.round}</span><h3>{combat.encounterKey || 'Encounter'}</h3></div>
                <Button size="sm" variant={combat.status === 'active' ? 'danger' : 'gold'} onClick={() => openCombat(combat.id)}>
                    {combat.status === 'active' ? 'Continue' : 'Enter battle'}
                </Button>
            </header>
            <div className="strpg-game-combatants">
                {(combat.participants ?? []).map((participant) => (
                    <div key={participant.id} className={`strpg-game-combatant ${participant.side} ${participant.alive ? '' : 'down'}`}>
                        <div><strong>{participant.name}</strong><span>{participant.side}{participant.isPlayer ? ' · you' : ''}</span></div>
                        <Bar label="HP" value={participant.hp} max={participant.maxHp} tone={participant.side === 'enemy' ? 'danger' : 'hp'} compact />
                    </div>
                ))}
            </div>
            <div className="strpg-game-combat-foot">
                <StatusBadge status={combat.status} />
                <span>{combat.isPlayerTurn ? 'Your turn' : combat.currentActor ? `${combat.currentActor}'s turn` : 'Waiting'}</span>
            </div>
        </section>
    );
}

function ChronicleCard({ dashboard, setTab }) {
    const story = dashboard.story;
    const journal = dashboard.journal ?? [];
    return (
        <section className="strpg-game-card chronicle">
            <header className="strpg-game-card-head">
                <div><span className="strpg-eyebrow">CHRONICLE</span><h3>{story?.current?.title ?? 'Story not started'}</h3></div>
                <Button size="sm" variant="ghost" onClick={() => setTab('story')}>Graph ›</Button>
            </header>
            {story?.current?.text && <p className="strpg-game-story">{story.current.text}</p>}
            {story?.ending && <Badge tone="success">Ending · {story.ending.title}</Badge>}
            <div className="strpg-game-journal">
                {journal.slice(-5).map((event, index) => (
                    <div key={`${event.at}-${index}`} className="strpg-game-journal-row">
                        <span>{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        <strong>{eventLabel(event)}</strong>
                    </div>
                ))}
                {!journal.length && <span className="strpg-muted">The journal fills as the campaign advances.</span>}
            </div>
        </section>
    );
}

export function Dashboard({
    campaignId, dashboard, loading, notify, onMutated, onRefresh, openCombat, setTab,
    chatKey, chatName, chatBinding, bindCurrentChat, createCampaign, campaigns,
}) {
    const [createOpen, setCreateOpen] = useState(false);
    const [games, setGames] = useState([]);
    const [gamesError, setGamesError] = useState(null);
    const [form, setForm] = useState({ gameVersionId: '', name: 'Emberfall Journey', playerName: 'Hero', classKey: '', bind: true });
    const [busy, setBusy] = useState(false);
    const [actionBusy, setActionBusy] = useState(null);
    const [npcKey, setNpcKey] = useState(null);
    const [shopNpc, setShopNpc] = useState(null);
    const [upgradeInfo, setUpgradeInfo] = useState(null);
    const [upgradeOpen, setUpgradeOpen] = useState(false);
    const [upgradeTarget, setUpgradeTarget] = useState('');
    const [upgrading, setUpgrading] = useState(false);

    const loadUpgrades = useCallback(async () => {
        if (!campaignId) { setUpgradeInfo(null); return; }
        try { setUpgradeInfo(await api(`/campaigns/${campaignId}/upgrades`)); } catch { setUpgradeInfo(null); }
    }, [campaignId]);

    useEffect(() => { loadUpgrades(); }, [loadUpgrades, dashboard?.campaign?.gameVersion?.id]);

    useEffect(() => {
        if (!createOpen) return;
        setGamesError(null);
        api('/published-games').then((rows) => {
            setGames(rows);
            if (rows[0]) {
                setForm((current) => ({
                    ...current,
                    gameVersionId: current.gameVersionId || rows[0].versionId,
                    classKey: current.classKey || rows[0].classes?.[0]?.key || '',
                }));
            }
        }).catch(setGamesError);
    }, [createOpen]);

    const availableUpgrades = upgradeInfo?.available ?? [];
    const latestUpgrade = availableUpgrades[availableUpgrades.length - 1] ?? null;
    const selectedUpgrade = availableUpgrades.find((entry) => entry.targetVersion.id === upgradeTarget) ?? latestUpgrade;
    const bound = chatBinding?.campaign?.id === campaignId;

    const explore = async () => {
        setActionBusy('explore');
        try {
            const result = await api(`/campaigns/${campaignId}/explore`, { method: 'POST', body: {} });
            if (result?.status === 'encounter' && result.combat?.id) {
                notify('Random encounter!', 'gold');
                openCombat(result.combat.id);
            } else if (result?.status === 'cooldown') {
                notify('The next encounter is still respawning.', 'info');
            } else {
                notify(result?.status === 'safe' ? 'The area is quiet.' : 'Explored.', 'info');
            }
            await onMutated?.();
        } catch (error) {
            notify(error.message, 'danger');
        } finally {
            setActionBusy(null);
        }
    };

    const snapshot = async () => {
        setActionBusy('save');
        try {
            await api(`/campaigns/${campaignId}/saves`, { method: 'POST', body: { label: 'Manual save' } });
            notify('Snapshot saved.', 'success');
            await onRefresh?.(campaignId, { silent: true });
        } catch (error) {
            notify(error.message, 'danger');
        } finally {
            setActionBusy(null);
        }
    };

    if (!campaignId) {
        return (
            <div className="strpg-dashboard onboarding">
                <section className="strpg-hero onboarding">
                    <div className="strpg-hero-glow" />
                    <div className="strpg-hero-copy">
                        <span className="strpg-eyebrow">STRPG · SILLYTAVERN RPG FRAMEWORK</span>
                        <h2>Turn chat into a real JRPG</h2>
                        <p>The rules engine owns maps, stats, combat, quests, and saves. The LLM owns natural language, characters, and narration. Choose a published game version and create your first Campaign.</p>
                        <div className="strpg-row">
                            <Button variant="gold" onClick={() => setCreateOpen(true)}>Create Campaign</Button>
                            <Button onClick={() => setTab('studio')}>Open Studio</Button>
                        </div>
                    </div>
                    <div className="strpg-hero-art"><div className="strpg-rune">S</div><span>ENGINE / STUDIO</span></div>
                </section>
                <div className="strpg-grid two">
                    <div className="strpg-panel">
                        <SectionTitle eyebrow="SAVED CAMPAIGNS" title="Campaigns" />
                        {campaigns.length ? campaigns.map((campaign) => (
                            <button type="button" className="strpg-campaign-row" key={campaign.id} onClick={() => setTab('dashboard')}>
                                <div><strong>{campaign.name}</strong><span>{campaign.worldName} · {campaign.locationName}</span></div>
                                <Badge tone="info">Lv.{campaign.player?.level ?? 1}</Badge>
                            </button>
                        )) : <Empty title="No Campaign yet" icon="◇">Your Campaign will appear here after creation.</Empty>}
                    </div>
                    <div className="strpg-panel">
                        <SectionTitle eyebrow="QUICK START" title="Checklist" />
                        <ol className="strpg-checklist">
                            <li className={games.length ? 'done' : ''}>A published game exists in Studio</li>
                            <li>Create a Campaign and bind the current chat</li>
                            <li>Accept the starting quest from the Dashboard</li>
                            <li>Travel to the forest edge and trigger a battle</li>
                            <li>Switch chats and verify the Campaign restores</li>
                        </ol>
                    </div>
                </div>
                <CreateCampaignModal
                    open={createOpen} games={games} error={gamesError} form={form} setForm={setForm} busy={busy}
                    onClose={() => setCreateOpen(false)}
                    onCreate={async () => {
                        setBusy(true);
                        try {
                            await createCampaign({ gameVersionId: form.gameVersionId, name: form.name, playerName: form.playerName, classKey: form.classKey }, form.bind);
                            setCreateOpen(false);
                        } catch (error) {
                            notify(error.message, 'danger');
                        } finally { setBusy(false); }
                    }}
                />
            </div>
        );
    }

    if (!dashboard && loading) return <Loading label="Loading Campaign..." />;
    if (!dashboard) return <Empty title="Unable to load Campaign" icon="!">Check the server plugin status.</Empty>;

    const { player, location, story, pendingCombat, save } = dashboard;

    return (
        <div className="strpg-game-panel">
            <section className="strpg-game-hero">
                <div className="strpg-game-hero-glow" />
                <div className="strpg-game-hero-copy">
                    <div className="strpg-game-hero-kicker">
                        <span>{dashboard.world?.name ?? 'Unknown world'}</span>
                        <span>{location.layer ?? 'region'} / {location.data?.siteType ?? location.type ?? 'scene'}</span>
                        <StatusBadge status={dashboard.campaign.status} />
                    </div>
                    <h2>{location.name}</h2>
                    <p>{location.description || 'No scene description yet.'}</p>
                    <div className="strpg-game-hero-actions">
                        <Button variant="gold" onClick={() => setTab('map')}>Open Map</Button>
                        <Button onClick={explore} disabled={actionBusy === 'explore'}>{actionBusy === 'explore' ? 'Exploring…' : 'Explore'}</Button>
                        <Button onClick={() => setTab('quests')}>Quest Journal</Button>
                        {pendingCombat && (
                            <Button variant="danger" onClick={() => openCombat(pendingCombat.id)}>
                                {pendingCombat.status === 'active' ? 'Continue Battle' : 'Enter Battle'}
                            </Button>
                        )}
                    </div>
                </div>
                <div className="strpg-game-hero-side">
                    <div className="strpg-game-sigil">S</div>
                    <div className="strpg-game-hero-facts">
                        <div><span>Session</span><strong>{save?.created_at ? new Date(save.created_at).toLocaleDateString() : 'New'}</strong></div>
                        <div><span>Binding</span><strong className={bound ? 'ok' : 'warn'}>{bound ? 'Chat bound' : 'Unbound'}</strong></div>
                        <div><span>Version</span><strong>v{dashboard.campaign.gameVersion?.version ?? '?'}</strong></div>
                    </div>
                </div>
            </section>

            <div className="strpg-game-strip">
                <div><span>HP</span><strong>{player.hp}/{player.stats.maxHp}</strong><i className="hp" style={{ width: `${Math.min(100, (player.hp / Math.max(1, player.stats.maxHp)) * 100)}%` }} /></div>
                <div><span>MP</span><strong>{player.mp}/{player.stats.maxMp}</strong><i className="mp" style={{ width: `${Math.min(100, (player.mp / Math.max(1, player.stats.maxMp)) * 100)}%` }} /></div>
                <div><span>EXP</span><strong>{player.xp}/{player.xpToNext}</strong><i className="xp" style={{ width: `${Math.min(100, (player.xp / Math.max(1, player.xpToNext)) * 100)}%` }} /></div>
                <div><span>GOLD</span><strong>{dashboard.inventory?.gold ?? player.gold} G</strong></div>
                <div><span>PARTY</span><strong>{(dashboard.party?.length ?? 0) + 1}</strong></div>
                <div><span>QUESTS</span><strong>{dashboard.activeQuests?.length ?? 0}</strong></div>
            </div>

            <div className="strpg-game-grid">
                <VitalsCard dashboard={dashboard} setTab={setTab} />
                <LocationCard
                    dashboard={dashboard} campaignId={campaignId} onMutated={onMutated} notify={notify} setTab={setTab}
                    busy={actionBusy} setBusy={setActionBusy}
                />
                <PartyCard dashboard={dashboard} setTab={setTab} onTalk={(npc) => setNpcKey(npc.npcKey ?? npc.key)} />
                <CombatCard dashboard={dashboard} openCombat={openCombat} />
                <QuestCard dashboard={dashboard} setTab={setTab} />
                <ChronicleCard dashboard={dashboard} setTab={setTab} />
            </div>

            <section className="strpg-game-card campaign-strip">
                <div className="strpg-game-campaign-row">
                    <div><span className="strpg-eyebrow">CAMPAIGN</span><strong>{dashboard.campaign.name}</strong><span className="strpg-muted">{chatName}</span></div>
                    <div className="strpg-game-campaign-actions">
                        <Button size="sm" variant={bound ? 'default' : 'gold'} onClick={bindCurrentChat} disabled={!chatKey || bound}>{bound ? 'Chat bound' : 'Bind chat'}</Button>
                        <Button size="sm" onClick={snapshot} disabled={actionBusy === 'save'}>{actionBusy === 'save' ? 'Saving…' : 'Snapshot'}</Button>
                        {latestUpgrade && (
                            <Button size="sm" variant="gold" onClick={() => { setUpgradeTarget(latestUpgrade.targetVersion.id); setUpgradeOpen(true); }}>
                                Upgrade to v{latestUpgrade.targetVersion.version}
                            </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setTab('settings')}>Saves & backups</Button>
                    </div>
                </div>
                <div className="strpg-game-campaign-meta">
                    <span>{save?.created_at ? `Last save ${new Date(save.created_at).toLocaleString()}` : 'No save yet'}</span>
                    <span>{dashboard.inventory?.stacks ?? 0} item stacks · {dashboard.inventory?.items ?? 0} items</span>
                    <span>{latestUpgrade ? `New content available: v${latestUpgrade.targetVersion.version}` : 'Up to date'}</span>
                </div>
            </section>

            {npcKey && (
                <NpcModal
                    campaignId={campaignId} npcKey={npcKey} onClose={() => setNpcKey(null)}
                    onShop={(key) => { setNpcKey(null); setShopNpc(key); }}
                    onMutated={onMutated} notify={notify}
                />
            )}
            {shopNpc && (
                <ShopModal campaignId={campaignId} npcKey={shopNpc} onClose={() => setShopNpc(null)} onMutated={onMutated} notify={notify} />
            )}

            <CreateCampaignModal
                open={createOpen} games={games} form={form} setForm={setForm} busy={busy}
                onClose={() => setCreateOpen(false)}
                onCreate={async () => {
                    setBusy(true);
                    try {
                        await createCampaign({ gameVersionId: form.gameVersionId, name: form.name, playerName: form.playerName, classKey: form.classKey }, form.bind);
                        setCreateOpen(false);
                    } catch (error) {
                        notify(error.message, 'danger');
                    } finally { setBusy(false); }
                }}
            />
            <UpgradeCampaignModal
                open={upgradeOpen} info={upgradeInfo} selected={selectedUpgrade} target={upgradeTarget}
                onTarget={setUpgradeTarget} busy={upgrading} onClose={() => setUpgradeOpen(false)}
                onUpgrade={async () => {
                    if (!selectedUpgrade) return;
                    setUpgrading(true);
                    try {
                        const result = await api(`/campaigns/${campaignId}/upgrade`, {
                            method: 'POST', body: { versionId: selectedUpgrade.targetVersion.id },
                        });
                        notify(`Campaign upgraded to v${result.toVersion.version}. Progress preserved and a snapshot was created.`, 'success');
                        setUpgradeOpen(false);
                        await loadUpgrades();
                        await onMutated?.();
                    } catch (error) {
                        notify(error.message, 'danger');
                    } finally { setUpgrading(false); }
                }}
            />
        </div>
    );
}

function UpgradeCampaignModal({ open, info, selected, target, onTarget, busy, onClose, onUpgrade }) {
    if (!open || !selected) return null;
    const changes = [
        ['Scenes', selected.diff.locations],
        ['Events', selected.diff.events],
        ['NPCs', selected.diff.npcs],
        ['Monsters', selected.diff.monsters],
        ['Items', selected.diff.items],
        ['Skills', selected.diff.skills],
        ['Quests', selected.diff.quests],
        ['Story nodes', selected.diff.storyNodes],
    ];
    const options = info?.available ?? [];
    return (
        <Modal
            open={open}
            title="Upgrade Campaign Content"
            subtitle="Insert a newer published Game Version into this Campaign while keeping the current save."
            onClose={onClose}
            wide
            footer={(
                <>
                    <Button onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button variant="gold" onClick={onUpgrade} disabled={busy || !selected.canUpgrade}>
                        {busy ? 'Upgrading...' : `Upgrade to v${selected.targetVersion.version}`}
                    </Button>
                </>
            )}
        >
            <div className="strpg-upgrade-modal">
                <Field label="Target version" hint="Only published versions of the same project are listed.">
                    <Select value={target || selected.targetVersion.id} onChange={(event) => onTarget(event.target.value)}>
                        {options.map((entry) => (
                            <option value={entry.targetVersion.id} key={entry.targetVersion.id}>
                                v{entry.targetVersion.version} · {entry.targetVersion.notes || 'Content module'}
                            </option>
                        ))}
                    </Select>
                </Field>
                <div className="strpg-upgrade-diff">
                    {changes.map(([label, diff]) => (
                        <div className="strpg-upgrade-row" key={label}>
                            <strong>{label}</strong>
                            <span>{diff.added.length ? diff.added.map((entry) => entry.name).join(', ') : 'No additions'}</span>
                            {diff.removed.length > 0 && <Badge tone="danger">{diff.removed.length} removed</Badge>}
                        </div>
                    ))}
                </div>
                {selected.blockers.length > 0 ? (
                    <div className="strpg-upgrade-blockers">
                        <strong>Upgrade blocked</strong>
                        <ul>{selected.blockers.map((blocker) => <li key={`${blocker.code}:${blocker.path}`}>{blocker.message}</li>)}</ul>
                    </div>
                ) : (
                    <p className="strpg-muted">
                        This is an in-place content upgrade: player stats, inventory, equipment, skills, quest progress, flags, discovered scenes and story position are mapped by key. A “Before upgrade” snapshot is created automatically.
                    </p>
                )}
            </div>
        </Modal>
    );
}

function CreateCampaignModal({ open, games, form, setForm, onClose, onCreate, busy, error }) {
    if (!open) return null;
    const selected = games.find((game) => game.versionId === form.gameVersionId);
    return (
        <Modal
            title="Create Campaign"
            subtitle="A Campaign is frozen to a game version. Publishing a new version never overwrites a running Campaign."
            onClose={onClose}
            footer={(
                <div className="strpg-row end">
                    <Button onClick={onClose}>Cancel</Button>
                    <Button variant="gold" onClick={onCreate} disabled={busy || !form.gameVersionId || !form.name}>{busy ? 'Creating...' : 'Create Campaign'}</Button>
                </div>
            )}
        >
            <ErrorBox error={error} />
            {games.length ? (
                <div className="strpg-form">
                    <Field label="Published Game">
                        <Select value={form.gameVersionId} onChange={(event) => {
                            const game = games.find((entry) => entry.versionId === event.target.value);
                            setForm({ ...form, gameVersionId: event.target.value, classKey: game?.classes?.[0]?.key ?? '' });
                        }}>
                            {games.map((game) => <option key={game.versionId} value={game.versionId}>{game.name} · v{game.version}</option>)}
                        </Select>
                    </Field>
                    {selected && (
                        <div className="strpg-game-summary">
                            <strong>{selected.worldName}</strong>
                            <span>{selected.description}</span>
                            <div className="strpg-row wrap">
                                <Badge>{selected.counts.locations} locations</Badge>
                                <Badge>{selected.counts.npcs} NPC</Badge>
                                <Badge>{selected.counts.monsters} monsters</Badge>
                                <Badge>{selected.counts.quests} quests</Badge>
                            </div>
                        </div>
                    )}
                    <div className="strpg-grid two">
                        <Field label="Campaign Name"><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
                        <Field label="Player Name"><Input value={form.playerName} onChange={(event) => setForm({ ...form, playerName: event.target.value })} /></Field>
                    </div>
                    <Field label="Class">
                        <Select value={form.classKey} onChange={(event) => setForm({ ...form, classKey: event.target.value })}>
                            {(selected?.classes ?? []).map((klass) => <option value={klass.key} key={klass.key}>{klass.name}</option>)}
                        </Select>
                    </Field>
                    <label className="strpg-checkbox">
                        <input type="checkbox" checked={form.bind} onChange={(event) => setForm({ ...form, bind: event.target.checked })} />
                        Bind the current SillyTavern chat after creation
                    </label>
                </div>
            ) : <Empty title="No published games" icon="⚒">Build and publish a Game Version in Studio first.</Empty>}
        </Modal>
    );
}

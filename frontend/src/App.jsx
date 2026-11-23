import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    api, getChatKey, getChatName, getStContext, hasChat,
} from './api.js';
import { Button, Confirm, Modal, StatusBadge, ErrorBox } from './ui.jsx';
import { Dashboard } from './components/Dashboard.jsx';
import { WorldMap } from './components/WorldMap.jsx';
import { Characters } from './components/Characters.jsx';
import { Inventory } from './components/Inventory.jsx';
import { Skills } from './components/Skills.jsx';
import { Quests } from './components/Quests.jsx';
import { CombatTab } from './components/CombatTab.jsx';
import { CombatArena } from './components/CombatArena.jsx';
import { Story } from './components/Story.jsx';
import { Studio } from './components/Studio.jsx';
import { Settings } from './components/Settings.jsx';
import { ChatHud } from './components/ChatHud.jsx';
import { maybeAutoScan } from './scopeScheduler.js';
import { currentCharacter } from './characterBridge.js';

class ViewErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        console.error('[STRPG] view crashed', error, info);
    }

    render() {
        if (this.state.error) {
            return (
                <div className="strpg-panel">
                    <h3>This view failed to load</h3>
                    <p className="strpg-muted">{this.state.error.message}</p>
                    <Button onClick={() => this.setState({ error: null })}>Retry</Button>
                </div>
            );
        }
        return this.props.children;
    }
}

const TABS = [
    { id: 'dashboard', label: 'Adventure', icon: '◈' },
    { id: 'map', label: 'World Map', icon: '⌘' },
    { id: 'characters', label: 'Party & People', icon: '☗' },
    { id: 'inventory', label: 'Inventory', icon: '▣' },
    { id: 'skills', label: 'Skills', icon: '✦' },
    { id: 'quests', label: 'Quests', icon: '!' },
    { id: 'combat', label: 'Combat', icon: '⚔' },
    { id: 'story', label: 'Chronicle', icon: '❖' },
    { id: 'studio', label: 'Studio', icon: '⚒' },
    { id: 'settings', label: 'Settings', icon: '⚙' },
];

function useToast() {
    const [toast, setToast] = useState(null);
    const timer = useRef(null);
    const notify = useCallback((message, tone = 'info') => {
        setToast({ message, tone });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setToast(null), 4200);
    }, []);
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
    return { toast, notify };
}


function panelRootStyle(layout) {
    if (layout.mode === 'dock') {
        return {
            left: `${layout.left}px`,
            top: `${layout.top}px`,
            width: `${layout.width}px`,
            height: `${layout.height}px`,
            right: 'auto',
            bottom: 'auto',
        };
    }
    if (layout.mode === 'overlay') {
        return {
            right: `${layout.right ?? 8}px`,
            top: `${layout.top ?? 8}px`,
            width: `${layout.width}px`,
            height: `${layout.height}px`,
            left: 'auto',
            bottom: 'auto',
        };
    }
    return { inset: 0, width: '100vw', height: '100vh' };
}

function panelRootClass(layout, tab) {
    const classes = ['strpg-root', `strpg-root-${layout.mode}`];
    if (layout.mode === 'dock' && layout.width < 640) classes.push('strpg-root-compact');
    if (layout.mode === 'dock' && layout.width < 380) classes.push('strpg-root-narrow');
    if (tab === 'studio') classes.push('strpg-root-studio');
    return classes.join(' ');
}

function ChatCombatAlert({ dashboard, onOpenCombat }) {
    const [host, setHost] = useState(null);
    useEffect(() => {
        const chat = document.getElementById('chat');
        if (!chat) return undefined;
        const element = document.createElement('div');
        element.id = 'strpg-chat-alert-host';
        chat.prepend(element);
        setHost(element);
        return () => {
            element.remove();
            setHost(null);
        };
    }, []);
    if (!host || !dashboard?.pendingCombat) return null;
    const combat = dashboard.pendingCombat;
    return createPortal(
        <div className={`strpg-chat-alert ${combat.status === 'active' ? 'active' : ''}`}>
            <div className="strpg-chat-alert-icon">⚔</div>
            <div className="strpg-chat-alert-body">
                <strong>{combat.status === 'active' ? 'Combat in Progress' : 'Hostile Encounter'}</strong>
                <span>{combat.encounter_key} · Round {combat.round}</span>
            </div>
            <Button size="sm" variant="gold" onClick={() => onOpenCombat(combat.id)}>
                {combat.status === 'active' ? 'Continue Battle' : 'Enter Battle'}
            </Button>
        </div>,
        host,
    );
}


function ChatDock({ dashboard, campaignId, onOpen, onCombat, onRefresh, notify, setTab }) {
    const [busy, setBusy] = useState(false);
    if (!dashboard?.campaign) return null;
    const player = dashboard.player;
    const explore = async () => {
        setBusy(true);
        try {
            const result = await api(`/campaigns/${campaignId}/explore`, { method: 'POST', body: {} });
            if (result?.status === 'encounter' && result.combat?.id) {
                notify?.('Random encounter!', 'gold');
                onCombat(result.combat.id);
            } else if (result?.status === 'cooldown') {
                notify?.('The next encounter is still respawning.', 'info');
            } else if (result?.status === 'safe') {
                notify?.('The area is quiet.', 'info');
            } else {
                notify?.(result?.status ? `Explore: ${result.status}` : 'Explored.', 'info');
            }
            await onRefresh?.(campaignId, { silent: true });
        } catch (error) {
            notify?.(error.message, 'danger');
        } finally {
            setBusy(false);
        }
    };
    return (
        <aside className="strpg-chat-dock">
            <header>
                <div><span className="strpg-eyebrow">STRPG · IN CHAT</span><strong>{dashboard.location?.name ?? 'Unknown'}</strong></div>
                <button type="button" onClick={() => { setTab('dashboard'); onOpen(); }} title="Open Control Center">Full</button>
            </header>
            <div className="strpg-chat-dock-stats">
                <span>HP {player?.hp}/{player?.stats?.maxHp}</span>
                <span>MP {player?.mp}/{player?.stats?.maxMp}</span>
                <span>{player?.gold ?? 0}G</span>
            </div>
            <div className="strpg-chat-dock-actions">
                <Button size="sm" onClick={() => { setTab('map'); onOpen(); }}>Map</Button>
                <Button size="sm" onClick={() => { setTab('characters'); onOpen(); }}>People</Button>
                <Button size="sm" onClick={() => { setTab('quests'); onOpen(); }}>Quests</Button>
                <Button size="sm" variant="gold" onClick={explore} disabled={busy}>{busy ? '...' : 'Explore'}</Button>
                {dashboard.pendingCombat && <Button size="sm" variant="danger" onClick={() => onCombat(dashboard.pendingCombat.id)}>Battle</Button>}
            </div>
            <footer>{dashboard.activeQuests?.length ?? 0} active quests · {dashboard.story?.current?.title ?? 'no story node'}</footer>
        </aside>
    );
}

function ProposalModal({ proposal, onClose, onConfirm, busy }) {
    if (!proposal) return null;
    const result = proposal.result ?? proposal;
    return (
        <Modal
            title="STRPG Movement Proposal"
            subtitle="The LLM only proposes. The rules engine has validated the move; you must confirm."
            onClose={onClose}
            footer={(
                <div className="strpg-row end">
                    <Button onClick={onClose}>Cancel</Button>
                    <Button variant="gold" disabled={!result.allowed || busy} onClick={onConfirm}>Confirm Move</Button>
                </div>
            )}
        >
            {result.allowed ? (
                <div className="strpg-proposal">
                    <span className="strpg-eyebrow">Destination</span>
                    <h3>{result.target?.name}</h3>
                    <p>{result.target?.description}</p>
                    <div className="strpg-kv"><span>Travel Cost</span><strong>{result.travelCost ?? 0} G</strong></div>
                    <div className="strpg-kv"><span>Validation</span><strong className="strpg-good">Passed</strong></div>
                </div>
            ) : (
                <div className="strpg-proposal">
                    <h3>Cannot move</h3>
                    <p>{result.reason}</p>
                    <span className="strpg-badge strpg-badge-danger">{result.code}</span>
                </div>
            )}
        </Modal>
    );
}

export function App() {
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState('dashboard');
    const [panelLayout, setPanelLayout] = useState({ mode: 'full' });
    useEffect(() => {
        if (!open) return undefined;
        const compute = () => {
            if (tab === 'studio') {
                setPanelLayout({ mode: 'full' });
                return;
            }
            const chat = document.getElementById('chat');
            const rect = chat?.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const gap = 8;
            const margin = 8;
            if (!rect || rect.width < 220) {
                setPanelLayout({
                    mode: 'overlay',
                    width: Math.min(760, Math.round(viewportWidth * 0.55)),
                    right: margin,
                    top: margin,
                    height: viewportHeight - margin * 2,
                });
                return;
            }
            const rightSpace = viewportWidth - rect.right - gap - margin;
            const leftSpace = rect.left - gap - margin;
            const minWidth = 320;
            if (rightSpace >= minWidth) {
                setPanelLayout({
                    mode: 'dock',
                    side: 'right',
                    left: Math.round(rect.right + gap),
                    top: Math.round(Math.max(margin, rect.top)),
                    height: Math.round(Math.min(rect.height, viewportHeight - margin * 2)),
                    width: Math.round(Math.min(760, rightSpace)),
                });
                return;
            }
            if (leftSpace >= minWidth) {
                const width = Math.round(Math.min(760, leftSpace));
                setPanelLayout({
                    mode: 'dock',
                    side: 'left',
                    left: Math.round(rect.left - gap - width),
                    top: Math.round(Math.max(margin, rect.top)),
                    height: Math.round(Math.min(rect.height, viewportHeight - margin * 2)),
                    width,
                });
                return;
            }
            setPanelLayout({
                mode: 'overlay',
                width: Math.min(700, Math.round(viewportWidth * 0.5)),
                right: margin,
                top: margin,
                height: viewportHeight - margin * 2,
            });
        };
        compute();
        window.addEventListener('resize', compute);
        const chat = document.getElementById('chat');
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(compute) : null;
        if (chat) observer?.observe(chat);
        observer?.observe(document.body);
        return () => {
            window.removeEventListener('resize', compute);
            observer?.disconnect();
        };
    }, [open, tab]);
    const [campaigns, setCampaigns] = useState([]);
    const [campaignId, setCampaignId] = useState(null);
    const [dashboard, setDashboard] = useState(null);
    const [chatBinding, setChatBinding] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [revision, setRevision] = useState(0);
    const [combat, setCombat] = useState({ open: false, id: null });
    const [proposal, setProposal] = useState(null);
    const [proposalBusy, setProposalBusy] = useState(false);
    const { toast, notify } = useToast();
    const seenMessages = useRef(new Set());
    const campaignRef = useRef(null);
    const [chatIdentity, setChatIdentity] = useState(() => {
        try {
            return { key: hasChat() ? getChatKey() : null, name: getChatName() };
        } catch {
            return { key: null, name: 'SillyTavern' };
        }
    });
    const chatKey = chatIdentity.key;
    const chatName = chatIdentity.name;
    const [boundNpcLine, setBoundNpcLine] = useState('');

    useEffect(() => {
        let cancelled = false;
        const character = (() => {
            try { return currentCharacter(); } catch { return null; }
        })();
        if (!campaignId || !character?.avatar) {
            setBoundNpcLine('');
            return () => {};
        }
        api(`/campaigns/${campaignId}/bindings/context?avatar=${encodeURIComponent(character.avatar)}`)
            .then((result) => { if (!cancelled) setBoundNpcLine(result?.context?.line ?? ''); })
            .catch(() => { if (!cancelled) setBoundNpcLine(''); });
        return () => { cancelled = true; };
    }, [campaignId, chatKey]);

    const updateChatIdentity = useCallback(() => {
        try {
            const next = { key: hasChat() ? getChatKey() : null, name: getChatName() };
            setChatIdentity(next);
            return next.key;
        } catch {
            setChatIdentity({ key: null, name: 'SillyTavern' });
            return null;
        }
    }, []);

    useEffect(() => { campaignRef.current = campaignId; }, [campaignId]);

    const loadCampaigns = useCallback(async () => {
        const rows = await api('/campaigns');
        setCampaigns(rows);
        return rows;
    }, []);

    const loadBinding = useCallback(async (key = chatKey) => {
        if (!key) return null;
        try {
            const binding = await api(`/chat-bindings/${encodeURIComponent(key)}`);
            setChatBinding(binding);
            return binding;
        } catch (err) {
            if (err.status === 404) {
                setChatBinding(null);
                return null;
            }
            throw err;
        }
    }, [chatKey]);

    const refresh = useCallback(async (id = campaignId, options = {}) => {
        if (!id) {
            setDashboard(null);
            return null;
        }
        if (!options.silent) setLoading(true);
        setError(null);
        try {
            const data = await api(`/campaigns/${id}/dashboard`);
            setDashboard(data);
            setRevision((value) => value + 1);
            return data;
        } catch (err) {
            setError(err);
            return null;
        } finally {
            if (!options.silent) setLoading(false);
        }
    }, [campaignId]);

    const selectCampaign = useCallback(async (id, options = {}) => {
        setCampaignId(id);
        if (!id) {
            setDashboard(null);
            return;
        }
        await refresh(id, options);
    }, [refresh]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const rows = await loadCampaigns();
                if (cancelled) return;
                const key = updateChatIdentity();
                const binding = await loadBinding(key);
                if (cancelled) return;
                if (binding?.campaign?.id) {
                    setCampaignId(binding.campaign.id);
                    await refresh(binding.campaign.id, { silent: true });
                } else if (rows.length === 1) {
                    setCampaignId(rows[0].id);
                    await refresh(rows[0].id, { silent: true });
                }
            } catch (err) {
                if (!cancelled) setError(err);
            }
        })();
        return () => { cancelled = true; };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!open) return;
        const key = updateChatIdentity();
        if (key) loadBinding(key);
    }, [open, updateChatIdentity, loadBinding]);

    useEffect(() => {
        let ctx;
        try { ctx = getStContext(); } catch { return undefined; }
        const onChatChanged = async () => {
            try {
                const key = updateChatIdentity();
                const binding = await loadBinding(key);
                if (binding?.campaign?.id) {
                    await selectCampaign(binding.campaign.id, { silent: true });
                } else {
                    setChatBinding(null);
                }
                setRevision((value) => value + 1);
            } catch (err) {
                notify(err.message, 'danger');
            }
        };
        const onMessage = async (messageId) => {
            const activeCampaign = campaignRef.current;
            if (!activeCampaign) return;
            const message = ctx.chat?.[messageId];
            if (!message?.mes) return;
            // Auto-scan only queues review candidates; failures never block the chat.
            void maybeAutoScan(activeCampaign, notify);
            // Keep the in-chat status rail in sync with narration even when the
            // message contains no STRPG tool call (quests, travel, combat logs).
            void refresh(activeCampaign, { silent: true });
            const dedupeKey = `${getChatKey()}:${messageId}:${message.swipe_id ?? 0}`;
            if (seenMessages.current.has(dedupeKey)) return;
            const match = String(message.mes).match(/<strpg>\s*([\s\S]*?)\s*<\/strpg>/i)
                ?? String(message.mes).match(/```(?:strpg|strpg-tool)\s*\n([\s\S]*?)```/i);
            if (!match) return;
            seenMessages.current.add(dedupeKey);
            let call;
            try {
                call = JSON.parse(match[1]);
            } catch {
                notify('LLM tool call was not valid JSON and was ignored.', 'warning');
                return;
            }
            const allowed = new Set([
                'strpg_propose_movement',
                'strpg_propose_encounter',
                'strpg_propose_character_reaction',
                'strpg_propose_relation',
                'strpg_propose_trade',
                'strpg_propose_recruit',
                'strpg_propose_tuition',
                'strpg_propose_recovery',
                'strpg_receive_signal',
                'strpg_propose_barter',
            ]);
            if (!allowed.has(call.tool)) {
                notify(`Disallowed tool call: ${call.tool}`, 'warning');
                return;
            }
            try {
                const result = await api(`/tools/${call.tool}`, {
                    method: 'POST',
                    body: { campaignId: activeCampaign, ...(call.args ?? {}) },
                });
                if (call.tool === 'strpg_propose_movement') {
                    setProposal({ result: result.result });
                } else if (call.tool === 'strpg_propose_encounter') {
                    notify('The LLM proposed a hostile encounter. A combat entrance is now available.', 'gold');
                    await refresh(activeCampaign, { silent: true });
                    setTab('combat');
                } else if (call.tool === 'strpg_propose_relation') {
                    notify('Relationship proposal queued for review. Open Integrations -> Bridge to approve it.', 'gold');
                } else if (call.tool === 'strpg_propose_barter') {
                    notify('Barter proposal queued: approve to take the item and start the service quest.', 'gold');
                } else if (call.tool === 'strpg_receive_signal') {
                    const released = result.result?.released?.length ?? 0;
                    notify(`Favour signal recorded. ${released} proposal(s) released.`, 'success');
                    await refresh(activeCampaign, { silent: true });
                } else if (['strpg_propose_trade', 'strpg_propose_recruit', 'strpg_propose_tuition', 'strpg_propose_recovery'].includes(call.tool)) {
                    notify('NPC service proposal queued for review. Open Integrations -> Bridge to accept or decline.', 'gold');
                } else {
                    notify('LLM narrative reaction proposal recorded; no stats changed.', 'info');
                }
            } catch (err) {
                notify(`Tool call failed: ${err.message}`, 'danger');
            }
        };
        const events = ctx.eventTypes ?? {};
        ctx.eventSource?.on?.(events.CHAT_CHANGED, onChatChanged);
        ctx.eventSource?.on?.(events.MESSAGE_RECEIVED, onMessage);
        return () => {
            ctx.eventSource?.removeListener?.(events.CHAT_CHANGED, onChatChanged);
            ctx.eventSource?.removeListener?.(events.MESSAGE_RECEIVED, onMessage);
        };
    }, [loadBinding, notify, refresh, selectCampaign, updateChatIdentity]);

    useEffect(() => {
        const onBridgeChanged = () => {
            if (campaignId) refresh(campaignId, { silent: true });
        };
        globalThis.window?.addEventListener?.('strpg:bridge-changed', onBridgeChanged);
        return () => globalThis.window?.removeEventListener?.('strpg:bridge-changed', onBridgeChanged);
    }, [campaignId, refresh]);

    useEffect(() => {
        const menu = document.getElementById('extensionsMenu');
        if (!menu) return undefined;
        const item = document.createElement('div');
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.id = 'strpg-menu-entry';
        item.innerHTML = '<div class="fa-solid fa-dice-d20"></div><span>STRPG</span>';
        item.addEventListener('click', () => setOpen(true));
        menu.append(item);
        return () => item.remove();
    }, []);

    useEffect(() => {
        if (!dashboard) return;
        try {
            const ctx = getStContext();
            const activeQuests = dashboard.activeQuests?.length ?? 0;
            const prompt = [
                '[STRPG GAME CONTEXT — authoritative]',
                `Campaign: ${dashboard.campaign.name}`,
                `World: ${dashboard.world?.name ?? 'unknown'} | Location: ${dashboard.location.name} (${dashboard.location.key})`,
                `Player: ${dashboard.player.name} Lv.${dashboard.player.level} | HP ${dashboard.player.hp}/${dashboard.player.stats.maxHp} | MP ${dashboard.player.mp}/${dashboard.player.stats.maxMp} | XP ${dashboard.player.xp}/${dashboard.player.xpToNext} | Gold ${dashboard.player.gold}`,
                `Active quests: ${dashboard.activeQuests.map((quest) => `${quest.name} [${quest.status}]`).join(' | ') || 'none'}`,
                `Story node: ${dashboard.story?.current?.title ?? 'none'}${dashboard.story?.ending ? ` | ENDING: ${dashboard.story.ending.title}` : ''}`,
                boundNpcLine ? `[BOUND NPC] ${boundNpcLine}` : '',
                dashboard.pendingCombat ? `PENDING COMBAT: ${dashboard.pendingCombat.id} (${dashboard.pendingCombat.status})` : 'PENDING COMBAT: none',
                'Rules: STRPG is the only authority for HP, MP, EXP, gold, items, skills, quests and combat. Never invent or change those numbers. Narrate only results returned by STRPG.',
                'If the player explicitly asks to move or a hostile encounter is clearly triggered, you may append exactly one proposal block:',
                '<strpg>{"tool":"strpg_propose_movement","args":{"location":"location_key"}}</strpg>',
                '<strpg>{"tool":"strpg_propose_encounter","args":{"monsters":[{"monsterKey":"monster_key","count":1}]}}</strpg>',
                'If the scene clearly changes an NPC relationship (help, betrayal, gift, promise), you may append one relation proposal. Max ±2, requires player approval:',
                '<strpg>{"tool":"strpg_propose_relation","args":{"npcKey":"npc_key","delta":1,"reason":"short evidence from the scene"}}</strpg>',
                'If the player clearly asks to buy or haggle, learn a skill, recruit someone, or help an exhausted companion, you may append one social proposal (proposal only, the player approves):',
                '<strpg>{"tool":"strpg_propose_trade","args":{"npcKey":"npc_key","itemKey":"item_key","quantity":1,"offerPrice":90}}</strpg>',
                '<strpg>{"tool":"strpg_propose_tuition","args":{"npcKey":"npc_key","skillKey":"skill_key"}}</strpg>',
                '<strpg>{"tool":"strpg_propose_recruit","args":{"npcKey":"npc_key"}}</strpg>',
                '<strpg>{"tool":"strpg_propose_recovery","args":{"npcKey":"npc_key"}}</strpg>',
                'When a non-cash cost is actually fulfilled in the scene (a favour done, a promise kept), send the matching receipt:',
                '<strpg>{"tool":"strpg_receive_signal","args":{"name":"favour_signal","note":"what the player did"}}</strpg>',
                '<strpg>{"tool":"strpg_propose_barter","args":{"npcKey":"npc_key","itemKey":"item_key"}}</strpg>',
                'A proposal is not an action. The player must confirm; never claim the move or combat already happened before STRPG confirms it.',
                'Do not output SQL, code, or tool calls for direct stat changes.',
            ].join('\n');
            ctx.setExtensionPrompt?.('STRPG_CONTEXT', prompt, 1, 2, false, 0);
        } catch {
            // SillyTavern context may not be ready; harmless.
        }
    }, [dashboard, boundNpcLine]);

    const bindCurrentChat = useCallback(async () => {
        if (!campaignId || !chatKey) return;
        setLoading(true);
        try {
            const binding = await api(`/campaigns/${campaignId}/bind-chat`, {
                method: 'POST',
                body: { chatKey, characterName: chatName },
            });
            setChatBinding(binding);
            notify('The current chat is bound to this Campaign. It will restore automatically after switching chats.', 'success');
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setLoading(false);
        }
    }, [campaignId, chatKey, chatName, notify]);

    const createCampaign = useCallback(async (input, bind) => {
        const created = await api('/campaigns', { method: 'POST', body: input });
        await loadCampaigns();
        setCampaignId(created.id);
        await refresh(created.id, { silent: true });
        if (bind && chatKey) {
            const binding = await api(`/campaigns/${created.id}/bind-chat`, {
                method: 'POST', body: { chatKey, characterName: chatName },
            });
            setChatBinding(binding);
        }
        setRevision((value) => value + 1);
        notify('Campaign created.', 'success');
        return created;
    }, [chatKey, chatName, loadCampaigns, notify, refresh]);

    const onMutated = useCallback(async (message) => {
        if (message) notify(message, 'success');
        await refresh(campaignId, { silent: true });
        setRevision((value) => value + 1);
    }, [campaignId, notify, refresh]);

    const handleProposalConfirm = async () => {
        if (!proposal) return;
        setProposalBusy(true);
        try {
            await api(`/campaigns/${campaignId}/move`, {
                method: 'POST',
                body: { location: proposal.result.target.key, idempotencyKey: `llm-move-${Date.now()}` },
            });
            setProposal(null);
            notify(`Moved to ${proposal.result.target.name}.`, 'success');
            await refresh(campaignId);
        } catch (err) {
            notify(err.message, 'danger');
        } finally {
            setProposalBusy(false);
        }
    };

    const openCombat = useCallback((id) => {
        setCombat({ open: true, id });
    }, []);

    const closeCombat = useCallback(async () => {
        setCombat({ open: false, id: null });
        await refresh(campaignId, { silent: true });
    }, [campaignId, refresh]);

    const bindStatus = chatBinding?.campaign?.id === campaignId;
    const activeTab = TABS.find((entry) => entry.id === tab);
    const common = {
        campaignId,
        campaigns,
        dashboard,
        revision,
        notify,
        onMutated,
        onRefresh: refresh,
        openCombat,
        chatKey,
        chatName,
        chatBinding,
        bindCurrentChat,
        loading,
        setCampaignId: selectCampaign,
        setTab,
        createCampaign,
        loadCampaigns,
    };

    return (
        <>
            {!open && dashboard && (
                <ChatHud
                    dashboard={dashboard}
                    campaignId={campaignId}
                    onOpen={() => setOpen(true)}
                    onCombat={openCombat}
                    onRefresh={refresh}
                    notify={notify}
                    setTab={setTab}
                />
            )}
            {dashboard?.pendingCombat && !combat.open && (
                <ChatCombatAlert dashboard={dashboard} onOpenCombat={openCombat} />
            )}
            {open && (
                <div className={panelRootClass(panelLayout, tab)} style={panelRootStyle(panelLayout)}>
                    <div className="strpg-shell" role="dialog" aria-label="STRPG RPG side panel">
                        <aside className="strpg-sidebar">
                            <div className="strpg-brand">
                                <div className="strpg-brand-mark">S</div>
                                <div>
                                    <strong>STRPG</strong>
                                    <span>CONTROL CENTER</span>
                                </div>
                            </div>
                            <nav className="strpg-nav">
                                {TABS.map((entry) => (
                                    <button key={entry.id} type="button" className={tab === entry.id ? 'active' : ''} onClick={() => setTab(entry.id)}>
                                        <span className="strpg-nav-icon">{entry.icon}</span>
                                        <span>{entry.label}</span>
                                    </button>
                                ))}
                            </nav>
                            <div className="strpg-sidebar-foot">
                                <div className="strpg-world-mini">
                                    <span>Current world</span>
                                    <strong>{dashboard?.world?.name ?? 'Not loaded'}</strong>
                                </div>
                                <div className="strpg-chat-state">
                                    <span className={`strpg-dot ${bindStatus ? 'ok' : 'warn'}`} />
                                    {bindStatus ? 'Chat bound' : 'Chat not bound'}
                                </div>
                            </div>
                        </aside>
                        <main className="strpg-main">
                            <header className="strpg-topbar">
                                <div className="strpg-topbar-left">
                                    <button type="button" className="strpg-back" onClick={() => setTab('dashboard')}>◈</button>
                                    <div>
                                        <span className="strpg-topbar-eyebrow">{activeTab?.label}</span>
                                        <h1>{dashboard?.campaign?.name ?? 'STRPG Framework'}</h1>
                                    </div>
                                </div>
                                <div className="strpg-topbar-right">
                                    <select className="strpg-campaign-select" value={campaignId ?? ''} onChange={(event) => selectCampaign(event.target.value || null)}>
                                        <option value="">Select Campaign</option>
                                        {campaigns.map((campaign) => (
                                            <option value={campaign.id} key={campaign.id}>{campaign.name} · Lv.{campaign.player?.level ?? 1}</option>
                                        ))}
                                    </select>
                                    <button type="button" className="strpg-close" onClick={() => setOpen(false)} title="Collapse to floating orb" aria-label="Collapse STRPG">×</button>
                                </div>
                            </header>
                            <div className="strpg-viewport">
                                {error && <ErrorBox error={error} onRetry={() => refresh()} />}
                                <ViewErrorBoundary key={tab}>
                                    {tab === 'dashboard' && <Dashboard {...common} />}
                                    {tab === 'map' && <WorldMap {...common} />}
                                    {tab === 'characters' && <Characters {...common} />}
                                    {tab === 'inventory' && <Inventory {...common} />}
                                    {tab === 'skills' && <Skills {...common} />}
                                    {tab === 'quests' && <Quests {...common} />}
                                    {tab === 'combat' && <CombatTab {...common} />}
                                    {tab === 'story' && <Story {...common} />}
                                    {tab === 'studio' && <Studio {...common} />}
                                    {tab === 'settings' && <Settings {...common} />}
                                </ViewErrorBoundary>
                            </div>
                        </main>
                    </div>
                </div>
            )}
            {combat.open && (
                <CombatArena
                    campaignId={campaignId}
                    combatId={combat.id}
                    onClose={closeCombat}
                    notify={notify}
                    onFinished={() => refresh(campaignId, { silent: true })}
                />
            )}
            <ProposalModal
                proposal={proposal}
                busy={proposalBusy}
                onClose={() => setProposal(null)}
                onConfirm={handleProposalConfirm}
            />
            {toast && <div className={`strpg-toast ${toast.tone}`}>{toast.message}</div>}
        </>
    );
}

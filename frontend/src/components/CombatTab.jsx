import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Button, Empty, ErrorBox, Loading, SectionTitle } from '../ui.jsx';

export function CombatTab({ campaignId, revision, openCombat, setTab }) {
    const [combat, setCombat] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    const load = async () => {
        if (!campaignId) return;
        setLoading(true);
        setError(null);
        try {
            setCombat(await api(`/campaigns/${campaignId}/combat`));
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => { load(); }, [campaignId, revision]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!campaignId) return <Empty title="No Campaign selected" icon="⚔" />;
    if (loading) return <Loading label="Loading combat..." />;
    if (error) return <ErrorBox error={error} onRetry={load} />;

    if (!combat || !Array.isArray(combat.participants)) {
        return (
            <div className="strpg-combat-tab">
                <SectionTitle eyebrow="COMBAT" title="Standalone Combat UI" description="Combat is not confined to chat text. When enemies appear, a combat entrance is added to the chat." />
                <div className="strpg-panel combat-empty">
                    <div className="strpg-combat-emblem">⚔</div>
                    <h3>No active combat</h3>
                    <p>Travel to a dangerous area and trigger a local encounter. You can also let the LLM submit <code>strpg_propose_encounter</code> proposals.</p>
                    <Button variant="gold" onClick={() => setTab('map')}>Go to World Map</Button>
                </div>
            </div>
        );
    }

    return (
        <div className="strpg-combat-tab">
            <SectionTitle
                eyebrow="COMBAT"
                title={combat.status === 'pending' ? 'Pending Combat' : combat.status === 'active' ? 'Combat in Progress' : 'Combat Result'}
                actions={<Badge tone={combat.status === 'active' ? 'danger' : 'gold'}>{combat.status}</Badge>}
            />
            <div className="strpg-panel combat-summary">
                <div>
                    <span className="strpg-eyebrow">{combat.encounterKey}</span>
                    <h3>{combat.status === 'pending' ? 'Enemies have appeared' : `Round ${combat.round}`}</h3>
                    <p>Party: {combat.participants.filter((participant) => participant.side === 'party').map((participant) => participant.name).join(', ')}</p>
                    <p>Enemies: {combat.participants.filter((participant) => participant.side === 'enemy').map((participant) => participant.name).join(', ')}</p>
                </div>
                <Button variant="gold" onClick={() => openCombat(combat.id)}>
                    {['victory', 'defeat', 'fled'].includes(combat.status) ? 'View Results' : 'Enter Combat UI'}
                </Button>
            </div>
        </div>
    );
}



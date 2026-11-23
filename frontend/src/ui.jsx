import React from 'react';

export function Button({ children, variant = 'default', size = 'md', className = '', ...props }) {
    return (
        <button type="button" className={`strpg-btn strpg-btn-${variant} strpg-btn-${size} ${className}`} {...props}>
            {children}
        </button>
    );
}

export function IconButton({ label, children, className = '', ...props }) {
    return <button type="button" title={label} aria-label={label} className={`strpg-icon-btn ${className}`} {...props}>{children}</button>;
}

export function Badge({ children, tone = 'neutral', className = '' }) {
    return <span className={`strpg-badge strpg-badge-${tone} ${className}`}>{children}</span>;
}

export function Bar({ value, max, tone = 'hp', label, compact = false }) {
    const percent = Math.max(0, Math.min(100, (Number(value) / Math.max(1, Number(max))) * 100));
    return (
        <div className={`strpg-bar-wrap ${compact ? 'compact' : ''}`}>
            <div className="strpg-bar-label">
                <span>{label}</span>
                <span>{Math.round(Number(value))} / {Math.round(Number(max))}</span>
            </div>
            <div className="strpg-bar-track"><div className={`strpg-bar-fill strpg-bar-${tone}`} style={{ width: `${percent}%` }} /></div>
        </div>
    );
}

export function Modal({ title, subtitle, children, onClose, wide = false, className = '', footer = null }) {
    return (
        <div className="strpg-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
            <div className={`strpg-modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true">
                <header className="strpg-modal-header">
                    <div>
                        <h3>{title}</h3>
                        {subtitle && <p>{subtitle}</p>}
                    </div>
                    <IconButton label="Close" onClick={onClose}>×</IconButton>
                </header>
                <div className="strpg-modal-body">{children}</div>
                {footer && <footer className="strpg-modal-footer">{footer}</footer>}
            </div>
        </div>
    );
}

export function Field({ label, hint, children, className = '' }) {
    return (
        <label className={`strpg-field ${className}`}>
            <span className="strpg-field-label">{label}</span>
            {children}
            {hint && <span className="strpg-field-hint">{hint}</span>}
        </label>
    );
}

export function Input(props) {
    return <input className="strpg-input" {...props} />;
}

export function Textarea(props) {
    return <textarea className="strpg-textarea" {...props} />;
}

export function Select({ children, ...props }) {
    return <select className="strpg-select" {...props}>{children}</select>;
}

export function Tabs({ tabs, value, onChange, className = '' }) {
    return (
        <div className={`strpg-tabs ${className}`}>
            {tabs.map((tab) => (
                <button type="button" key={tab.value} className={value === tab.value ? 'active' : ''} onClick={() => onChange(tab.value)}>
                    {tab.label}{tab.count != null ? <span className="strpg-tab-count">{tab.count}</span> : null}
                </button>
            ))}
        </div>
    );
}

export function Empty({ icon = '◇', title, children, action = null }) {
    return (
        <div className="strpg-empty">
            <div className="strpg-empty-icon">{icon}</div>
            <h4>{title}</h4>
            {children && <p>{children}</p>}
            {action}
        </div>
    );
}

export function Loading({ label = 'Loading…' }) {
    return <div className="strpg-loading"><span className="strpg-spinner" />{label}</div>;
}

export function ErrorBox({ error, onRetry = null }) {
    if (!error) return null;
    return (
        <div className="strpg-error">
            <div>
                <strong>{error.code ?? 'ERROR'}</strong>
                <span>{error.message ?? String(error)}</span>
            </div>
            {onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}
        </div>
    );
}

export function SectionTitle({ eyebrow, title, actions = null, description = null }) {
    return (
        <div className="strpg-section-title">
            <div>
                {eyebrow && <div className="strpg-eyebrow">{eyebrow}</div>}
                <h2>{title}</h2>
                {description && <p>{description}</p>}
            </div>
            {actions && <div className="strpg-section-actions">{actions}</div>}
        </div>
    );
}

export function Stat({ label, value, sub = null, tone = '' }) {
    return (
        <div className={`strpg-stat ${tone}`}>
            <span>{label}</span>
            <strong>{value}</strong>
            {sub && <small>{sub}</small>}
        </div>
    );
}

export function StatusBadge({ status }) {
    const tones = {
        DRAFT: 'neutral', VALIDATION: 'warning', REVIEWED: 'info', PUBLISHED: 'success',
        active: 'success', pending: 'warning', victory: 'gold', defeat: 'danger', fled: 'info',
        available: 'info', ready_to_turn_in: 'gold', completed: 'success', turned_in: 'success', failed: 'danger',
        draft: 'neutral', published: 'success', archived: 'neutral',
    };
    return <Badge tone={tones[status] ?? 'neutral'}>{status}</Badge>;
}

export function ProgressDots({ value, max }) {
    const total = Math.max(1, Number(max));
    const current = Math.max(0, Math.min(total, Number(value)));
    if (total > 12) return <span className="strpg-progress-text">{current} / {total}</span>;
    return (
        <span className="strpg-dots">
            {Array.from({ length: total }, (_, index) => <i key={index} className={index < current ? 'filled' : ''} />)}
        </span>
    );
}

export function Confirm({ open, title, children, onConfirm, onCancel, confirmLabel = 'Confirm', danger = false }) {
    if (!open) return null;
    return (
        <Modal title={title} onClose={onCancel} footer={(
            <div className="strpg-row end">
                <Button onClick={onCancel}>Cancel</Button>
                <Button variant={danger ? 'danger' : 'gold'} onClick={onConfirm}>{confirmLabel}</Button>
            </div>
        )}>
            {children}
        </Modal>
    );
}



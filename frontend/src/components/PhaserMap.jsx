import React, { useEffect, useRef } from 'react';
import Phaser from 'phaser';

const LAYER_COLORS = {
    world: 0xc8c8c8,
    region: 0x63b47a,
    settlement: 0xe0b85c,
    interior: 0x8db4d8,
    room: 0xa78bd8,
    dungeon: 0xb072d0,
    floor: 0xd08a6a,
};

function visibleLocations(data) {
    const all = data?.locations ?? [];
    const current = data?.current;
    if (!current) return all;
    const linked = new Set((data.connections ?? [])
        .filter((connection) => connection.fromId === current.id || connection.toId === current.id)
        .flatMap((connection) => [connection.fromId, connection.toId]));
    if (['world', 'region'].includes(current.layer)) {
        return all.filter((location) => ['world', 'region', 'settlement'].includes(location.layer) || linked.has(location.id));
    }
    if (current.layer === 'settlement') {
        return all.filter((location) => {
            return location.id === current.id
                || location.parentKey === current.key
                || location.key === current.parentKey
                || linked.has(location.id);
        });
    }
    return all.filter((location) => {
        return location.id === current.id
            || location.parentKey === current.key
            || location.key === current.parentKey
            || linked.has(location.id)
            || (current.parentKey && location.parentKey === current.parentKey);
    });
}

class MapScene extends Phaser.Scene {
    constructor() {
        super('strpg-map');
        this.nodes = new Map();
        this.selectedId = null;
    }

    init(data = {}) {
        const payload = this.registry?.get?.('strpgMapPayload') ?? {};
        this.mapData = data?.mapData ?? this.mapData ?? payload.mapData;
        if (!this.mapData) return;
        this.allLocations = this.mapData.locations;
        this.locations = visibleLocations(this.mapData);
        this.connections = (this.mapData.connections ?? []).filter((connection) => {
            return this.locations.some((entry) => entry.id === connection.fromId)
                && this.locations.some((entry) => entry.id === connection.toId);
        });
        this.selectedId = data?.selectedId ?? this.selectedId ?? payload.selectedId;
        this.onSelect = data?.onSelect ?? this.onSelect ?? payload.onSelect;
    }

    create() {
        if (!this.mapData) return;
        const width = this.scale.width;
        const height = this.scale.height;
        const bounds = this.locations.reduce((acc, location) => ({
            minX: Math.min(acc.minX, location.x), maxX: Math.max(acc.maxX, location.x),
            minY: Math.min(acc.minY, location.y), maxY: Math.max(acc.maxY, location.y),
        }), { minX: 0, maxX: 1000, minY: 0, maxY: 540 });
        const padX = Math.max(80, (bounds.maxX - bounds.minX) * 0.12);
        const padY = Math.max(60, (bounds.maxY - bounds.minY) * 0.18);
        this.offsetX = padX - bounds.minX;
        this.offsetY = padY - bounds.minY;
        this.worldWidth = bounds.maxX - bounds.minX + padX * 2;
        this.worldHeight = bounds.maxY - bounds.minY + padY * 2;
        const zoom = Math.min(width / this.worldWidth, height / this.worldHeight);
        this.cameras.main.setBackgroundColor('#0a0e16');
        this.cameras.main.setZoom(zoom);
        this.cameras.main.centerOn(this.worldWidth / 2, this.worldHeight / 2);
        this.input.on('wheel', (_pointer, _objects, _dx, dy) => {
            const next = Phaser.Math.Clamp(this.cameras.main.zoom - dy * 0.001, 0.35, 3);
            this.cameras.main.setZoom(next);
        });

        const grid = this.add.graphics();
        grid.lineStyle(1, 0x9bb2c8, 0.05);
        for (let x = 0; x < this.worldWidth; x += 32) grid.lineBetween(x, 0, x, this.worldHeight);
        for (let y = 0; y < this.worldHeight; y += 32) grid.lineBetween(0, y, this.worldWidth, y);

        this.edges = this.add.graphics();
        this.drawEdges();
        for (const location of this.locations) this.createNode(location);
        this.refreshSelection();

        this.add.text(16, 14, this.mapData.current?.name ?? 'STRPG Map', {
            fontFamily: 'Georgia, serif', fontSize: '20px', color: '#ece3cf',
        }).setScrollFactor(0);
        this.add.text(16, 42, 'Scroll to zoom · drag empty space to pan · click a node', {
            fontFamily: 'Inter, sans-serif', fontSize: '11px', color: '#8c9caf',
        }).setScrollFactor(0);

        this.cameras.main.setBounds(0, 0, this.worldWidth, this.worldHeight);
        this.cameras.main.startFollow(this.add.zone(this.offsetX + (this.locations.find((entry) => entry.id === this.mapData.current?.id)?.x ?? 0), this.offsetY + (this.locations.find((entry) => entry.id === this.mapData.current?.id)?.y ?? 0), 2, 2), true, 0.06, 0.06);
        this.cameras.main.setDeadzone(width * 0.25, height * 0.25);
        this.input.on('pointerdown', (pointer) => {
            if (pointer.rightButtonDown()) return;
        });
        this.input.on('pointermove', (pointer) => {
            if (!pointer.isDown) return;
            this.cameras.main.scrollX -= (pointer.x - pointer.prevPosition.x) / this.cameras.main.zoom;
            this.cameras.main.scrollY -= (pointer.y - pointer.prevPosition.y) / this.cameras.main.zoom;
        });
    }

    pointFor(location) {
        return { x: this.offsetX + location.x, y: this.offsetY + location.y };
    }

    drawEdges() {
        this.edges.clear();
        for (const connection of this.connections) {
            const from = this.locations.find((entry) => entry.id === connection.fromId);
            const to = this.locations.find((entry) => entry.id === connection.toId);
            if (!from || !to) continue;
            const a = this.pointFor(from);
            const b = this.pointFor(to);
            const current = connection.fromId === this.mapData.current?.id || connection.toId === this.mapData.current?.id;
            this.edges.lineStyle(current ? 2 : 1.2, current ? 0xe0b85c : 0x8c9caf, current ? 0.7 : 0.35);
            this.edges.lineBetween(a.x, a.y, b.x, b.y);
            if (connection.travelCost > 0) {
                this.add.text((a.x + b.x) / 2, (a.y + b.y) / 2 - 10, `${connection.travelCost}G`, {
                    fontFamily: 'Inter, sans-serif', fontSize: '10px', color: '#e0b85c',
                }).setOrigin(0.5);
            }
        }
    }

    createNode(location) {
        const point = this.pointFor(location);
        const color = LAYER_COLORS[location.layer] ?? LAYER_COLORS[location.type] ?? 0x9bb2c8;
        const known = location.discovered || location.id === this.mapData.current?.id;
        const current = location.id === this.mapData.current?.id;
        const circle = this.add.circle(point.x, point.y, current ? 22 : 18, 0x0b111b, 0.95)
            .setStrokeStyle(current ? 3 : 2, color, known ? 1 : 0.4)
            .setInteractive({ useHandCursor: true });
        circle.on('pointerdown', () => {
            this.selectedId = location.id;
            this.refreshSelection();
            this.onSelect?.(location);
        });
        const label = this.add.text(point.x, point.y + 28, known ? location.name : 'Unexplored', {
            fontFamily: 'Inter, sans-serif', fontSize: '11px', color: known ? '#e6dfd0' : '#657487',
        }).setOrigin(0.5);
        const sub = this.add.text(point.x, point.y + 43, known ? location.layer : '???', {
            fontFamily: 'Inter, sans-serif', fontSize: '9px', color: '#77889b',
        }).setOrigin(0.5);
        this.nodes.set(location.id, { circle, label, sub, color, point, current });
        if (current) {
            this.tweens.add({ targets: circle, scale: 1.12, duration: 1000, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
            this.add.circle(point.x, point.y, 34, undefined, 0).setStrokeStyle(1, color, 0.35);
        }
    }

    refreshSelection() {
        for (const [id, node] of this.nodes) {
            const selected = id === this.selectedId;
            node.circle.setStrokeStyle(selected ? 4 : node.current ? 3 : 2, selected ? 0xffffff : node.color, selected ? 1 : 0.9);
        }
    }

    setSelected(id) {
        this.selectedId = id;
        this.refreshSelection();
    }
}

export function PhaserMap({ data, selectedId, onSelect }) {
    const containerRef = useRef(null);
    const gameRef = useRef(null);

    useEffect(() => {
        if (!containerRef.current || !data) return undefined;
        const scene = new MapScene();
        scene.mapData = data;
        scene.selectedId = selectedId;
        scene.onSelect = onSelect;
        const game = new Phaser.Game({
            type: Phaser.AUTO,
            parent: containerRef.current,
            resolution: Math.min(2, globalThis.devicePixelRatio || 1),
            render: { antialias: true, roundPixels: false },
            backgroundColor: '#0a0e16',
            scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
            scene,
            input: { mouse: { preventDefaultWheel: true } },
        });
        game.registry.set('strpgMapPayload', { mapData: data, selectedId, onSelect });
        gameRef.current = game;
        return () => {
            game.destroy(true);
            gameRef.current = null;
        };
    }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const scene = gameRef.current?.scene?.getScene('strpg-map');
        scene?.setSelected?.(selectedId);
    }, [selectedId]);

    return <div ref={containerRef} className="strpg-phaser-map" />;
}




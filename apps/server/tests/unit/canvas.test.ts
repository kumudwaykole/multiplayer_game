import { describe, expect, it } from 'vitest';
import {
  TURN_BYTE_BUDGET,
  TurnCanvas,
  drawOperationSchema,
  type DrawOperation,
} from '../../src/drawing/operations.js';

const begin = (strokeId: string, point: [number, number] = [10, 10]): DrawOperation => ({
  type: 'stroke.begin',
  strokeId,
  tool: 'pen',
  color: '#FF0000',
  width: 6,
  point,
});

describe('drawing operation schema', () => {
  it('rejects unknown fields, bad colours, widths and oversized batches', () => {
    expect(drawOperationSchema.safeParse({ ...begin('s1'), extra: 1 }).success).toBe(false);
    expect(drawOperationSchema.safeParse({ ...begin('s1'), color: 'red' }).success).toBe(false);
    expect(drawOperationSchema.safeParse({ ...begin('s1'), width: 41 }).success).toBe(false);
    expect(drawOperationSchema.safeParse({ ...begin('s1'), point: [Infinity, 1] }).success).toBe(false);
    const points = Array.from({ length: 65 }, (_, i) => [i, i]);
    expect(drawOperationSchema.safeParse({ type: 'stroke.points', strokeId: 's1', points }).success).toBe(false);
  });
});

describe('TurnCanvas', () => {
  it('assigns sequences and action IDs and canonicalizes input', () => {
    const canvas = new TurnCanvas('t1');
    const first = canvas.apply('c1', begin('s1', [-50, 9000.6]), 5);
    expect(first.canvasSeq).toBe(1);
    expect(first.actionId).toBe('a1');
    expect(first.operation).toMatchObject({ point: [0, 699], color: '#ff0000' });
    const points = canvas.apply('c2', { type: 'stroke.points', strokeId: 's1', points: [[1.4, 2.6]] }, 10);
    expect(points.actionId).toBe('a1');
    expect(points.operation).toMatchObject({ points: [[1, 3]] });
    const end = canvas.apply('c3', { type: 'stroke.end', strokeId: 's1' }, 20);
    expect(end.canvasSeq).toBe(3);
  });

  it('forces the eraser to white', () => {
    const canvas = new TurnCanvas('t1');
    const eraser: DrawOperation = { type: 'stroke.begin', strokeId: 's1', tool: 'eraser', color: '#123456', width: 6, point: [1, 1] };
    const op = canvas.apply('c1', eraser, 0);
    expect(op.operation).toMatchObject({ color: '#ffffff' });
  });

  it('enforces stroke lifetime: one open stroke, no mixing, no reuse', () => {
    const canvas = new TurnCanvas('t1');
    expect(() => canvas.apply('c0', { type: 'stroke.points', strokeId: 's1', points: [[1, 1]] }, 0)).toThrow();
    canvas.apply('c1', begin('s1'), 0);
    expect(() => canvas.apply('c2', begin('s2'), 0)).toThrow();
    expect(() => canvas.apply('c3', { type: 'stroke.points', strokeId: 's2', points: [[1, 1]] }, 0)).toThrow();
    expect(() => canvas.apply('c4', { type: 'fill', point: [5, 5], color: '#000000' }, 0)).toThrow();
    canvas.apply('c5', { type: 'stroke.end', strokeId: 's1' }, 0);
    expect(() => canvas.apply('c6', begin('s1'), 0)).toThrow();
  });

  it('limits a stroke to 10 seconds', () => {
    const canvas = new TurnCanvas('t1');
    canvas.apply('c1', begin('s1'), 0);
    expect(() => canvas.apply('c2', { type: 'stroke.points', strokeId: 's1', points: [[1, 1]] }, 12_000)).toThrow(
      /too long/,
    );
    canvas.apply('c3', { type: 'stroke.end', strokeId: 's1' }, 12_000);
  });

  it('only undoes the latest active action, including fill and clear', () => {
    const canvas = new TurnCanvas('t1');
    canvas.apply('c1', begin('s1'), 0);
    canvas.apply('c2', { type: 'stroke.end', strokeId: 's1' }, 0);
    canvas.apply('c3', { type: 'fill', point: [5, 5], color: '#00ff00' }, 0); // a2
    canvas.apply('c4', { type: 'clear' }, 0); // a3
    expect(() => canvas.apply('c5', { type: 'undo', targetActionId: 'a1' }, 0)).toThrow();
    canvas.apply('c6', { type: 'undo', targetActionId: 'a3' }, 0);
    canvas.apply('c7', { type: 'undo', targetActionId: 'a2' }, 0);
    canvas.apply('c8', { type: 'undo', targetActionId: 'a1' }, 0);
    expect(() => canvas.apply('c9', { type: 'undo', targetActionId: 'a1' }, 0)).toThrow();
  });

  it('stops accepting drawing once the turn budget is used, but still ends strokes', () => {
    const canvas = new TurnCanvas('t1');
    canvas.bytes = TURN_BYTE_BUDGET - 10;
    expect(() => canvas.apply('c1', begin('s1'), 0)).toThrow(/size limit/);
    canvas.bytes = 0;
    canvas.apply('c2', begin('s2'), 0);
    canvas.bytes = TURN_BYTE_BUDGET;
    expect(canvas.apply('c3', { type: 'stroke.end', strokeId: 's2' }, 0).canvasSeq).toBe(2);
  });

  it('rolls back uncommitted operations and rebuilds stroke and undo state', () => {
    const canvas = new TurnCanvas('t1');
    canvas.apply('c1', begin('s1'), 0);
    canvas.apply('c2', { type: 'stroke.end', strokeId: 's1' }, 0);
    canvas.markCommitted(2);
    canvas.apply('c3', { type: 'clear' }, 0);
    canvas.apply('c4', begin('s2'), 0);
    canvas.rollbackToCommitted();
    expect(canvas.lastSeq).toBe(2);
    expect(canvas.hasOpenStroke).toBe(false);
    // a1 is the latest active action again; a new action continues from a2.
    expect(canvas.apply('c5', { type: 'undo', targetActionId: 'a1' }, 0).actionId).toBe('a2');
  });
});

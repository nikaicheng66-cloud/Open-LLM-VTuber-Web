import { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { useMode } from '@/context/mode-context';
interface Position {
  x: number
  y: number
}

interface UseDraggableProps {
  componentId: string
}

/**
 * A custom hook that provides dragging functionality for components
 * @param isPet - Whether the current mode is pet mode or not
 * @param componentId - Unique identifier for the component
 * @returns Object containing refs and handlers for dragging functionality
 */
export function useDraggable({ componentId }: UseDraggableProps) {
  const { mode } = useMode();
  const isPet = mode === 'pet';
  // Track if the element is currently being dragged
  const [isDragging, setIsDragging] = useState(false);

  // Refs to store position data that persists between renders
  const positionRef = useRef<Position>({ x: 0, y: 0 });
  const dragStartRef = useRef<Position>({ x: 0, y: 0 });
  const elementRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef(false);
  const draggingRef = useRef(false);

  // [deskpet] React re-renders reset the inline transform to the default and the box jumped back
  // (then forward again on the next move): put the dragged position back after every render
  useLayoutEffect(() => {
    const el = elementRef.current;
    const { x, y } = positionRef.current;
    if (el && (x || y)) {
      el.style.transform = `translateX(-50%) translate(${x}px, ${y}px)`;
    }
  });

  const setHover = (on: boolean) => {
    if (!isPet || hoveredRef.current === on) return;
    hoveredRef.current = on;
    (window.api as any)?.updateComponentHover(componentId, on);
  };

  // [deskpet] while the box counts as "hovered" the whole transparent window takes the mouse, so the
  // desktop underneath can't be clicked. If a mouseleave was missed (fast move, drag ended outside),
  // release it as soon as the pointer is seen anywhere else.
  useEffect(() => {
    if (!isPet) return undefined;
    const onMove = (e: MouseEvent) => {
      if (!hoveredRef.current || draggingRef.current) return;
      const el = elementRef.current;
      if (el && !el.contains(e.target as Node)) setHover(false);
    };
    document.addEventListener('mousemove', onMove, true);
    return () => document.removeEventListener('mousemove', onMove, true);
  });

  /**
   * Handle mouse enter event for pet mode
   * Notifies the electron main process about hover state
   */
  const handleMouseEnter = () => {
    setHover(true);
  };

  /**
   * Handle mouse leave event for pet mode
   * Notifies the electron main process about hover state
   */
  const handleMouseLeave = () => {
    if (!draggingRef.current) setHover(false);
  };

  /**
   * Handles the start of dragging operation
   * Sets up mouse move and mouse up listeners
   */
  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    draggingRef.current = true;
    // Calculate the initial offset
    dragStartRef.current = {
      x: e.clientX - positionRef.current.x,
      y: e.clientY - positionRef.current.y,
    };

    /**
     * Updates element position during mouse movement
     */
    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!elementRef.current) return;

      // Calculate new position
      const newPosition = {
        x: moveEvent.clientX - dragStartRef.current.x,
        y: moveEvent.clientY - dragStartRef.current.y,
      };

      // Update position ref for future calculations
      positionRef.current = newPosition;

      elementRef.current.style.transform = `translateX(-50%) translate(${positionRef.current.x}px, ${positionRef.current.y}px)`;
    };

    /**
     * Cleanup function for mouse events
     */
    const handleMouseUp = (upEvent: MouseEvent) => {
      setIsDragging(false);
      draggingRef.current = false;
      // released outside the box: no mouseleave will come, so give the desktop its mouse back now
      const under = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
      if (!elementRef.current || !under || !elementRef.current.contains(under)) setHover(false);
      // Clean up event listeners
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('mouseup', handleMouseUp, true);
    };

    // Add event listeners with capture phase
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('mouseup', handleMouseUp, true);
  };

  return {
    elementRef,
    isDragging,
    handleMouseDown,
    handleMouseEnter,
    handleMouseLeave,
  };
}

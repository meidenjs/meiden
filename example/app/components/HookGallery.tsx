"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from "react";

const ThemeContext = createContext("sage");

function reducer(value: number, action: "up" | "down") {
  return action === "up" ? value + 1 : value - 1;
}

export function UseClientExample() {
  return (
    <div className="hook-card">
      <strong>use client</strong>
      <span>Marked by the directive at the top of the module.</span>
    </div>
  );
}

export function UseContextExample() {
  const theme = useContext(ThemeContext);

  return (
    <div className="hook-card">
      <strong>useContext</strong>
      <span>Theme: {theme}</span>
    </div>
  );
}

export function UseEffectExample() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  return (
    <div className="hook-card">
      <strong>useEffect</strong>
      <span>{ready ? "Mounted in the browser." : "Waiting for hydration."}</span>
    </div>
  );
}

export function UseMemoExample() {
  const label = useMemo(() => "Memoized island value", []);

  return (
    <div className="hook-card">
      <strong>useMemo</strong>
      <span>{label}</span>
    </div>
  );
}

export function UseReducerExample() {
  const [value, dispatch] = useReducer(reducer, 1);

  return (
    <div className="hook-card">
      <strong>useReducer</strong>
      <span>Value: {value}</span>
      <button type="button" onClick={() => dispatch("up")}>Increase</button>
    </div>
  );
}

export function UseRefExample() {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="hook-card">
      <strong>useRef</strong>
      <input ref={inputRef} placeholder="Focus is tracked by React" />
    </div>
  );
}

export function UseTransitionExample() {
  const [isPending, startTransition] = useTransition();
  const [label, setLabel] = useState("Idle");

  return (
    <div className="hook-card">
      <strong>useTransition</strong>
      <span>{isPending ? "Pending..." : label}</span>
      <button type="button" onClick={() => startTransition(() => setLabel("Updated"))}>
        Start
      </button>
    </div>
  );
}

export default function HookGallery() {
  return (
    <ThemeContext.Provider value="sage">
      <section className="hook-gallery">
        <UseClientExample />
        <UseContextExample />
        <UseEffectExample />
        <UseMemoExample />
        <UseReducerExample />
        <UseRefExample />
        <UseTransitionExample />
      </section>
    </ThemeContext.Provider>
  );
}

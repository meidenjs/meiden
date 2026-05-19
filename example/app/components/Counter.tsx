"use client";

import { useState } from "react";

export default function Counter({ initial = 0 }: { initial?: number }) {
  const [count, setCount] = useState(initial);

  return (
    <button className="counter" type="button" onClick={() => setCount(count + 1)}>
      Count {count}
    </button>
  );
}

"use client";

import dynamic from "next/dynamic";

const PrivyEntry = dynamic(() => import("./PrivyEntry"), { ssr: false });
export default function EntryClient() { return <PrivyEntry />; }

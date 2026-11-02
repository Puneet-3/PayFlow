const paths = {
  wallet: ["M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0-3 3v13a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H6a2 2 0 0 1 0-4", "M21 12h-4a2 2 0 0 0 0 4h4"],
  grid: ["M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"],
  activity: ["M3 12h4l3-8 4 16 3-8h4"],
  send: ["M7 17 17 7M7 7h10v10"],
  receive: ["M17 7 7 17M17 17H7V7"],
  plus: ["M12 5v14M5 12h14"],
  arrow: ["M4 12h16m-6-6 6 6-6 6"],
  logout: ["M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M13 8l4 4-4 4M8 12h13"],
  clock: ["M12 8v4l3 2", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
  refresh: ["M20 7v5h-5M4 17v-5h5", "M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2"],
  search: ["M21 21l-5-5", "M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0"],
  eye: ["M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0"],
  eyeOff: ["M3 3l18 18M10.5 5.1A12 12 0 0 1 12 5c6 0 10 7 10 7a20 20 0 0 1-4 4M6 6C3.5 8.5 2 12 2 12s4 7 10 7a12 12 0 0 0 5-1M10 10a3 3 0 0 0 4 4"],
  close: ["M6 6l12 12M18 6 6 18"],
  check: ["m5 12 4 4L19 6"],
  shield: ["M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z", "m8 12 3 3 5-5"],
  info: ["M12 11v6M12 7h.01", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
  chevron: ["m9 5 7 7-7 7"],
};

export function Icon({ name, size = 20, className = "" }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {(paths[name] || paths.wallet).map((d, index) => <path d={d} key={index} />)}
  </svg>;
}

export function Brand({ light = false, onHome }) {
  return <a className={`brand${light ? " brand-light" : ""}`} href="/" aria-label="PayFlow home" onClick={(event) => { if (onHome) { event.preventDefault(); onHome(); } }}>
    <span className="brand-mark"><Icon name="wallet" size={23} /></span>
    <span>PayFlow<span className="brand-dot">ONLINE</span></span>
  </a>;
}

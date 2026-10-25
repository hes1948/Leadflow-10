import Link from "next/link";
import styles from "./workspace.module.css";

export default function WorkspaceShell({ children, active = "setup" }: {
  children: React.ReactNode; active?: "setup" | "settings";
}) {
  return <div className={styles.workspace}>
    <header className={styles.header}>
      <Link href="/" className={styles.brand} aria-label="BookMoreJobs home">
        <span className={styles.mark}>B<span /></span>
        <span>Book<b>MoreJobs</b><small>YOUR NEXT JOB. ALREADY HANDLED.</small></span>
      </Link>
      <nav aria-label="Workspace navigation" className={styles.nav}>
        <Link href="/dashboard">Dashboard <span aria-hidden="true">↗</span></Link>
        <Link href="/settings" aria-current={active === "settings" ? "page" : undefined}>Settings</Link>
      </nav>
    </header>
    <main className={styles.main}>{children}</main>
    <footer className={styles.footer}><span>BookMoreJobs · Built for the work ahead.</span>
      <div><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></div>
    </footer>
  </div>;
}

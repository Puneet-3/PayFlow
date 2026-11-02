import AuthScreen from "./components/AuthScreen.jsx";
import Dashboard from "./components/Dashboard.jsx";
import { useWallet } from "./hooks/useWallet.js";

export default function App() {
  const model = useWallet();
  return model.session ? <Dashboard model={model} /> : <AuthScreen authenticate={model.authenticate} busy={model.authBusy} message={model.authMessage} />;
}

import { Routes, Route } from 'react-router-dom';
import Header from './components/Header';
import ChatAssistant from './components/ChatAssistant';
import Home from './pages/Home';
import Work from './pages/Work';
import Contacts from './pages/Contacts';

function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 pt-16">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/work" element={<Work />} />
          <Route path="/contacts" element={<Contacts />} />
        </Routes>
      </main>
      <ChatAssistant />
    </div>
  );
}

export default App;

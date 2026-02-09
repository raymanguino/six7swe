import { useState, useRef, useEffect } from 'react';
import { apiRequest } from '../utils/api';
import { INPUT_LIMITS } from '../constants';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

const EXAMPLE_QUESTIONS = [
  "What technologies do you work with daily?",
  "Can you describe a challenging project you worked on?",
  "How do you ensure code quality and security?",
  "What's your experience with team collaboration?",
];

const GREEN_DOT_STYLE = {
  boxShadow:
    '0 0 3px 1px rgba(52, 211, 153, 0.5), 0 0 6px 2px rgba(52, 211, 153, 0.25), inset 0 0 2px 0 rgba(255, 255, 255, 0.4)',
};

const formatTimestamp = (date: Date): string => {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  // For older messages, show date and time
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
};

export default function ChatAssistant() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMessage = text.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage, timestamp: new Date() }]);
    setIsLoading(true);

    try {
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      const data = await apiRequest('/chat', {
        method: 'POST',
        body: JSON.stringify({ message: userMessage, history }),
      });
      setMessages((prev) => [...prev, { role: 'assistant', content: data.response, timestamp: new Date() }]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'Sorry, I encountered an error. Please try again later.',
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = () => sendMessage(input);
  const handleExampleClick = (question: string) => sendMessage(question);

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const hasUserMessages = messages.some((m) => m.role === 'user');

  return (
    <>
      {/* Chat Toggle Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-6 right-6 bg-primary-600 text-white rounded-full p-4 shadow-lg hover:bg-primary-700 dark:bg-primary-500 dark:hover:bg-primary-400 transition-colors z-50"
        aria-label="Toggle chat"
      >
        <svg
          className="w-6 h-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          {isOpen ? (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          ) : (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          )}
        </svg>
      </button>

      {/* Chat Window */}
      {isOpen && (
        <div className="fixed bottom-24 left-3 right-3 sm:left-auto sm:right-6 sm:w-[480px] h-[420px] max-h-[min(420px,calc(100vh-7rem))] sm:max-h-[calc(100vh-8rem)] bg-white dark:bg-gray-800 rounded-lg shadow-2xl flex flex-col z-50 border border-gray-200 dark:border-gray-600">
          {/* Chat Header */}
          <div className="bg-primary-600 dark:bg-primary-700 text-white p-4 rounded-t-lg">
            <h3 className="font-semibold">Chat with Ray</h3>
            <p className="text-sm text-primary-100 flex items-center gap-2 mt-0.5">
              <span
                className="relative inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0"
                style={GREEN_DOT_STYLE}
                aria-hidden
              />
              Online now
            </p>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {!hasUserMessages && (
              <div className="space-y-3">
                <h4 className="font-medium text-gray-800 dark:text-gray-200 text-center">What would you like to know?</h4>
                <p className="text-sm text-gray-600 dark:text-gray-400 text-center">
                  Ask me about my experience, skills, or how I might fit your role. I&apos;ll keep it short—ask for more detail anytime.
                </p>
                <div className="flex flex-col gap-2 pt-1">
                  {EXAMPLE_QUESTIONS.map((q, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => handleExampleClick(q)}
                      disabled={isLoading}
                      className="text-left text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 hover:border-primary-300 dark:hover:border-primary-500 text-gray-700 dark:text-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg p-3 ${
                    msg.role === 'user'
                      ? 'bg-primary-600 dark:bg-primary-500 text-white'
                      : 'bg-gray-100 dark:bg-gray-600 text-gray-800 dark:text-gray-200'
                  }`}
                >
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                </div>
                <span
                  className={`text-xs mt-1 px-1 ${
                    msg.role === 'user'
                      ? 'text-gray-500 dark:text-gray-400'
                      : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {formatTimestamp(msg.timestamp)}
                </span>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 dark:bg-gray-600 rounded-lg p-3">
                  <div className="flex space-x-1">
                    <div className="w-2 h-2 bg-gray-400 dark:bg-gray-400 rounded-full animate-bounce"></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="p-4 border-t border-gray-200 dark:border-gray-600">
            <div className="flex space-x-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value.slice(0, INPUT_LIMITS.chatMessage))}
                onKeyPress={handleKeyPress}
                placeholder="Ask me anything about my experience, skills, or background…"
                maxLength={INPUT_LIMITS.chatMessage}
                className="flex-1 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"
                rows={2}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                className="bg-primary-600 dark:bg-primary-500 text-white px-4 py-2 rounded-lg hover:bg-primary-700 dark:hover:bg-primary-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

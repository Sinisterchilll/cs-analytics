import React from 'react';

type Message = {
  id: string;
  actor_type: string;
  message_parts: string[];
  created_time: string;
};

interface MessageListProps {
  messages: Message[];
}

const getActorStyle = (actor?: string) => {
  const actorUpper = (actor || 'SYSTEM').toUpperCase();
  switch (actorUpper) {
    case 'BOT':
      return 'bg-blue-200 text-blue-700 dark:bg-blue-800 dark:text-blue-100';
    case 'USER':
    case 'AGENT':
      return 'bg-green-200 text-green-700 dark:bg-green-800 dark:text-green-100';
    default:
      return 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200';
  }
};

export function MessageList({ messages }: MessageListProps) {
  if (!messages.length) {
    return <div className="text-zinc-500 px-2 py-8">No messages found.</div>;
  }
  return (
    <div className="flex flex-col gap-4 mt-5">
      {messages.map((msg) => (
        <div key={msg.id} className="rounded-lg shadow px-4 py-2 bg-zinc-50 dark:bg-zinc-800">
          <div className="flex items-center gap-3 mb-1">
            <span className={`py-1 px-3 rounded text-xs font-bold ${getActorStyle(msg.actor_type)}`}>{(msg.actor_type || 'SYSTEM').toUpperCase()}</span>
            <span className="text-xs text-zinc-500">{new Date(msg.created_time).toLocaleString()}</span>
          </div>
          {msg.message_parts.map((text, i) => (
            <div className="ml-2 text-base text-zinc-800 dark:text-zinc-100" key={i}>{text}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

const store: any[] = [];

export function saveEvent(event: any) {
  store.push({
    ...event,
    createdAt: new Date().toISOString(),
  });
}

export function getEvents() {
  return store;
}

export function updateEvent(id: string, update: any) {
  const item = store.find(x => x.id === id);
  if (item) Object.assign(item, update);
}
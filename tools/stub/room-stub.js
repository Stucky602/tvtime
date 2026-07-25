export async function getMyRoomState() {
  return {
    room: { id: 'r1', code: 'ABCDEF', platforms: ['netflix'], include_reality: false },
    user: { id: 'me', display_name: 'Kevin', genre_prefs: [1], tab_seen_at: {}, session_presets: [] },
    partner: { id: 'them', display_name: 'Wife' },
  };
}

export async function createRoom() { return { status: 'OK' }; }

export async function joinRoom() { return { status: 'OK' }; }

export async function leaveRoom() { return { status: 'OK' }; }

export async function listReclaimMembers() { return { status: 'OK' }; }

export async function reclaimMembership() { return { status: 'OK' }; }

export async function removeMember() { return { status: 'OK' }; }

export async function resetMyData() { return { status: 'OK' }; }

export async function updateGenrePrefs() { return { status: 'OK' }; }

export async function updateIncludeReality() { return { status: 'OK' }; }

export async function updatePlatforms() { return { status: 'OK' }; }

export async function updateSessionPresets() { return { status: 'OK' }; }

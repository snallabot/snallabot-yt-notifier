import Koa from "koa"
import Router from "@koa/router"
import bodyParser from "@koa/bodyparser"

const app = new Koa()
const router = new Router()

export type SnallabotBaseEvent = { key: string, event_type: string }
export type Trigger5Min = { key: "time", event_type: "5_MIN_TRIGGER" }
type AddChannelEvent = { key: "yt_channels", id: string, timestamp: string, event_type: "ADD_CHANNEL", channel_id: string, discord_server: string, title_keyword: string }
type RemoveChannelEvent = { key: "yt_channels", id: string, timestamp: string, event_type: "REMOVE_CHANNEL", channel_id: string, discord_server: string }
type BroadcastEvent = { key: string, id: string, timestamp: string, event_type: "YOUTUBE_BROADCAST", video: string }
type EventQueryResponse = { "ADD_CHANNEL": Array<AddChannelEvent>, "REMOVE_CHANNEL": Array<RemoveChannelEvent> }

function extractTitle(html: string) {
    const titleTagIndex = html.indexOf('<meta name="title"')
    const sliced = html.slice(titleTagIndex)
    const titleTag = sliced.slice(0, sliced.indexOf(">"))
    return titleTag.replace('<meta name="title" content="', "").replace('>', "").replace('"', "")
}

function extractVideo(html: string) {
    const linkTagIndex = html.indexOf('<link rel="canonical" href="')
    const sliced = html.slice(linkTagIndex)
    const linkTag = sliced.slice(0, sliced.indexOf(">"))
    return linkTag.replace('<link rel="canonical" href="', "").replace('>', "").replace('"', "")
}



router.post("/hook", async (ctx) => {
    const events = await fetch("https://snallabot-event-sender-b869b2ccfed0.herokuapp.com/query", {
        method: "POST",
        body: JSON.stringify({ event_types: ["ADD_CHANNEL", "REMOVE_CHANNEL"], key: "yt_channels" }),
        headers: {
            "Content-Type": "application/json"
        }
    }).then(res => res.json() as Promise<EventQueryResponse>)
    //TODO: Replace with Object.groupBy
    let state = {} as { [key: string]: Array<AddChannelEvent> }
    events.ADD_CHANNEL.forEach(a => {
        const k = `${a.channel_id}|${a.discord_server}`
        if (!state[k]) {
            state[k] = [a]
        } else {
            state[k].push(a)
            state[k] = state[k].sort((a: AddChannelEvent, b: AddChannelEvent) => (new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())) // reverse chronologically order
        }
    })
    events.REMOVE_CHANNEL.forEach(a => {
        const k = `${a.channel_id}|${a.discord_server}`
        if (new Date(a.timestamp) > new Date(state[k][0].timestamp)) {
            delete state[k]
        }
    })
    const currentChannelServers = Object.keys(state).map(k => {
        const [channel_id, discord_server] = k.split("|")
        return { channel_id, discord_server, title_keyword: state[k][0].title_keyword }
    })
    const channels = await Promise.all(currentChannelServers.map(c => c.channel_id)
        .map(channel_id =>
            fetch(`https://www.youtube.com/channel/${channel_id}/live`)
                .then(res => res.text())
                .then(t => t.includes('"isLive":true') ? [{ channel_id, title: extractTitle(t), video: extractVideo(t) }] : [])
        ))
    const currentlyLiveStreaming = channels.flat()
    console.log(`currently streaming: ${currentlyLiveStreaming}`)
    const pastBroadcasts = await Promise.all(currentlyLiveStreaming.map(c =>
        fetch("https://snallabot-event-sender-b869b2ccfed0.herokuapp.com/query", {
            method: "POST",
            body: JSON.stringify({ event_types: ["YOUTUBE_BROADCAST"], key: c.channel_id }),
            headers: {
                "Content-Type": "application/json"
            }
        })
            .then(res => res.json() as Promise<{ "YOUTUBE_BROADCAST": Array<BroadcastEvent> }>)
            .then(t => ({ [c.channel_id]: t.YOUTUBE_BROADCAST.map(b => b.video) }))
    ))
    const channelToPastBroadcastMap: { [key: string]: Array<string> } = pastBroadcasts.reduce((prev, curr) => {
        Object.assign(prev, curr)
        return prev
    }, {})
    const newBroadcasts = currentlyLiveStreaming.filter(c => !channelToPastBroadcastMap[c.channel_id]?.includes(c.video))
    console.log(`broadcasts that are new: newBroadcasts`)
    await Promise.all(newBroadcasts.map(b => fetch("https://snallabot-event-sender-b869b2ccfed0.herokuapp.com/post", {
        method: "POST",
        body: JSON.stringify({ key: b.channel_id, event_type: "YOUTUBE_BROADCAST", delivery: "EVENT_SOURCE", video: b.video }),
        headers: {
            "Content-Type": "application/json"
        }
    })
    ))
    const channelTitleMap = newBroadcasts.map(c => ({ [c.channel_id]: { title: c.title, video: c.video } })).reduce((prev, curr) => {
        Object.assign(prev, curr)
        return prev
    }, {})
    await Promise.all(currentChannelServers.filter(c => channelTitleMap[c.channel_id] && channelTitleMap[c.channel_id].title.includes(c.title_keyword)).map(c =>
        fetch("https://snallabot-event-sender-b869b2ccfed0.herokuapp.com/post", {
            method: "POST",
            body: JSON.stringify({ key: c.discord_server, event_type: "MADDEN_BROADCAST", delivery: "EVENT_SOURCE", title: channelTitleMap[c.channel_id].title, video: channelTitleMap[c.channel_id].video }),
            headers: {
                "Content-Type": "application/json"
            }
        })
    ))

    ctx.status = 200
})

app.use(bodyParser({ enableTypes: ["json"], encoding: "utf-8" }))
    .use(async (ctx, next) => {
        try {
            await next()
        } catch (err: any) {
            console.error(err)
            ctx.status = 500;
            ctx.body = {
                message: err.message
            };
        }
    })
    .use(router.routes())
    .use(router.allowedMethods())

export default app

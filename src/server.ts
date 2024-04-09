import Koa from "koa"
import Router from "@koa/router"
import bodyParser from "@koa/bodyparser"

const app = new Koa()
const router = new Router()

export type SnallabotBaseEvent = { key: string, event_type: string }
export type Trigger5Min = { key: "time", event_type: "5_MIN_TRIGGER" }
type AddChannelEvent = { key: "yt_channels", id: string, timestamp: string, event_type: "ADD_CHANNEL", channel_id: string, discord_server: string, titleKeyword: string }
type RemoveChannelEvent = { key: "yt_channels", id: string, timestamp: string, event_type: "REMOVE_CHANNEL", channel_id: string, discord_server: string }
type EventQueryResponse = { "ADD_CHANNEL": Array<AddChannelEvent>, "REMOVE_CHANNEL": Array<RemoveChannelEvent> }

function extractTitle(html: string) {
    const match = html.match(/<meta name="title"([^ <] *) >/)
    if (!match) {
        return ""
    }
    return match[1].replace('<meta name="title" content="', "").replace('">', "")
}
router.post("/hook", async (ctx) => {
    const events = await fetch("https://snallabot-event-sender-b869b2ccfed0.herokuapp.com/query", {
        method: "POST",
        body: JSON.stringify({ event_type: ["ADD_CHANNEL", "REMOVE_CHANNEL"], key: "yt_channels" }),
        headers: {
            "Content-Type": "application/json"
        }
    }).then(res => res.json() as Promise<EventQueryResponse>)
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
        return { channel_id, discord_server, titleKeyword: state[k][0].titleKeyword }
    })
    const channels = await Promise.all(currentChannelServers.map(c => c.channel_id)
        .map(channel_id => {
            return fetch(`https://www.youtube.com/channel/${channel_id}/live`).then(res => res.text()).then(t => t.includes('{"text":" watching now"}') ? [{ channel_id, title: extractTitle(t) }] : []
            )
        }))
    const currentlyLiveStreaming = channels.flat()
    const channelTitleMap = currentlyLiveStreaming.map(c => ({ [c.channel_id]: c.title })).reduce((prev, curr) => {
        Object.assign(prev, curr)
        return prev
    }, {})
    console.log(channelTitleMap)
    await Promise.all(currentChannelServers.filter(c => channelTitleMap[c.channel_id] && channelTitleMap[c.channel_id].includes(c.titleKeyword)).map(c => {
        fetch("https://snallabot-event-sender-b869b2ccfed0.herokuapp.com/post", {
            method: "POST",
            body: JSON.stringify({ key: c.discord_server, event_type: "MADDEN_BROADCAST", event_delivery: "EVENT_SOURCE", title: channelTitleMap[c.channel_id], video: `https://www.youtube.com/${c.channel_id}/live` }),
            headers: {
                "Content-Type": "application/json"
            }
        })
    }))

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

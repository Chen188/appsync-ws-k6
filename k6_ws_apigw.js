import ws from "k6/ws";
import { check } from "k6";
import { Rate, Trend, Counter } from 'k6/metrics';

const url = "wss://xxxxxxx.execute-api.cn-northwest-1.amazonaws.com.cn/api";

let ramp_up_duration   = 2,  // 在x秒内建立 *target* 个ws连接
    keepalive_duration = 500,   // 保持x秒ws连接不断开
    tear_down_duration = 5,   // tear down
    target             = 10 // 建立连接数
    ;

// 统计ws响应请求的成功率
export let ResponseSuccessRate = new Rate('ResponseSuccessRate');

var nicknameCounter = new Counter('nickname_counter');
var joinRoomSuccessCounter = new Counter('joined_success_counter');
var msgRecvCounter = new Counter('msg_received_counter');

let ws_resp_delay = new Trend('ws_resp_delay(ms)');
let broadcastTime = null;

export let options = {
  scenarios: {
    'apigw-listener': {  // 建立ws连接
      executor: 'ramping-vus',
      exec: 'listener', // defaults to "default"
      startVUs: 0,
      stages: [
        { duration: ramp_up_duration   + 's', target: target },
        { duration: keepalive_duration + 's', target: target },
        { duration: tear_down_duration + 's', target: 0 },
      ],
      gracefulRampDown: '3s',
      gracefulStop: '3s',
    },
    'apigw-broadcast': { //
      executor: 'per-vu-iterations',
      exec: 'broadcast',
      vus: 1,
      iterations: 1,
      startTime: (ramp_up_duration + Math.floor(keepalive_duration * Math.random())) + 's',
      maxDuration: '5s',
      gracefulStop: '3s',
    }
  },
  thresholds: {
    ResponseSuccessRate: [
      'rate>0.90', // should be great than 90%
      { threshold: "rate>0.85", abortOnFail: true }, // stop early if less than 85%
    ]
  },
};

export function listener() {
  let requester =  new Requester();
  
  requester.init_connection()
}

export function broadcast() {
  let requester =  new Requester();
  requester.init_connection('Broadcast');
}

export class Requester {
  init_connection(role='listner', params = { tags: { my_tag: "apigw" } }) {

    const response = ws.connect(url, this._params, (socket) => {
  
      function gen_nickname() {
        if (role == 'listner') 
          return Date.now() + Math.random()
        else
          return 'Broadcast'
      }

      function join_room(room_name='Room1') {
        if(null === socket)
          return;
        socket.send('/join ' + room_name);
      }

      socket.on("open", () => {
        socket.send(gen_nickname())
      });

      socket.setInterval(function () {
        socket.ping()
      }, 5*60*1000)

      socket.on("message", (msg) => {
        if(msg.startsWith('Using nick')) {
          nicknameCounter.add(1);
          join_room();
        } else if(msg.startsWith('Joined chat')) {
          if(role != 'listner') {
            // broadcast: should send msg
            broadcastTime = +new Date();
            console.log('now broadcast ' + broadcastTime)
            socket.send(broadcastTime)
          } else {
            // listner: should wait for broadcast msg
          }

          joinRoomSuccessCounter.add(1);
        } else if(msg.startsWith('Broadcast')) {
          msgRecvCounter.add(1);

          var received_time = +msg.split(' ')[1]

          var delay = +new Date() - received_time;
          ws_resp_delay.add(delay);
        } else {
          console.error('unknown msg: ', msg)
        }
      });
  
      socket.on("close", () => console.log("disconnected"));
  
      socket.on("error", (e) => {
        if (e.error() != "websocket: close sent") {
          ResponseSuccessRate.add(0);
          console.log("An unexpected error occured: ", e.error());
        }
      });
    });
  
    check(response, { "status is 101": r => r && r.status === 101 });
  }
}